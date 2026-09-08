import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  CliRuntimeBinding,
  ProviderConnectionOperation,
} from '../../../../../src/core/ports/aiProvider';
import { createWindowsKnownFoldersForTest } from '../../../../../src/infrastructure/providers/cli/windowsKnownFolders';
import {
  WINDOWS_ALIAS_DRIVES,
  type WindowsSubstMappingPort,
} from '../../../../../src/infrastructure/providers/cli/windowsSubstMapping';
import {
  createWindowsAliasMarkerStoreForTest,
  createWindowsWorkspaceAliasForTest,
  type WindowsAliasMarker,
  type WindowsAliasMarkerStore,
  type WindowsWorkspaceAliasLease,
} from '../../../../../src/infrastructure/providers/cli/windowsWorkspaceAlias';
import { parseSafeSemVer } from '../../../../../src/shared/contracts/provider';

const userProfile = 'C:\\Users\\student';
const runtimeRoot = `${userProfile}\\AppData\\Local\\StudyApp\\providers`;
const markerRoot = `${runtimeRoot}\\alias-markers`;
const geminiRoot = `${userProfile}\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli`;
const knownFolders = createWindowsKnownFoldersForTest({
  appData: `${userProfile}\\AppData\\Roaming`,
  localAppData: `${userProfile}\\AppData\\Local`,
  programFiles: 'C:\\Program Files',
  architecture: 'x64',
});
const operation = Object.freeze({
  requestId: '30000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal,
}) satisfies ProviderConnectionOperation;

const binding = Object.freeze({
  providerId: 'gemini_cli',
  canonicalLauncherPath: 'C:\\Program Files\\nodejs\\node.exe',
  canonicalEntryPath: `${geminiRoot}\\dist\\index.js`,
  canonicalPackageManifestPath: `${geminiRoot}\\package.json`,
  canonicalPlatformPackageManifestPath: null,
  fixedPrefixArgs: Object.freeze([`${geminiRoot}\\dist\\index.js`]),
  version: parseSafeSemVer('0.55.1'),
  launcherSha256: 'a'.repeat(64),
  entrySha256: 'b'.repeat(64),
  packageManifestSha256: 'c'.repeat(64),
  platformPackageManifestSha256: null,
  bindingSha256: 'd'.repeat(64),
  recipeId: 'gemini-0.55-policy-json-v1',
  credentialScope: 'provider_global',
  signerClassification: 'nodejs',
  checkedAt: '2026-09-02T00:00:00.000Z',
}) satisfies CliRuntimeBinding<'gemini_cli', 'provider_global'>;

class SubstMappings implements WindowsSubstMappingPort {
  readonly mappings = new Map<string, string>();
  readonly mapCalls: Array<readonly [string, string]> = [];
  readonly unmapCalls: Array<readonly [string, string]> = [];
  readonly listOperations: ProviderConnectionOperation[] = [];
  readonly mapOperations: ProviderConnectionOperation[] = [];
  readonly unmapOperations: ProviderConnectionOperation[] = [];
  failUnmapTarget: string | null = null;
  hangUnmapTarget: string | null = null;

  async list(
    requestedOperation: ProviderConnectionOperation,
  ): Promise<ReadonlyMap<string, string>> {
    this.listOperations.push(requestedOperation);
    return new Map(this.mappings);
  }

  async map(
    drive: string,
    target: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<void> {
    this.mapCalls.push([drive, target]);
    this.mapOperations.push(requestedOperation);
    this.mappings.set(drive, target);
  }

  async unmap(
    drive: string,
    expectedTarget: string,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<void> {
    this.unmapCalls.push([drive, expectedTarget]);
    this.unmapOperations.push(requestedOperation);
    if (this.hangUnmapTarget === expectedTarget) {
      return new Promise<void>(() => undefined);
    }
    if (this.failUnmapTarget === expectedTarget) throw new Error('UNMAP_FAILED');
    if (this.mappings.get(drive) !== expectedTarget) throw new Error('MAPPING_CHANGED');
    this.mappings.delete(drive);
  }
}

class Markers implements WindowsAliasMarkerStore {
  readonly root = markerRoot;
  readonly markers = new Map<string, WindowsAliasMarker>();
  readonly writes: WindowsAliasMarker[] = [];
  readonly writeOperations: ProviderConnectionOperation[] = [];
  readonly removeCalls: string[] = [];
  readonly removeOperations: ProviderConnectionOperation[] = [];
  onWrite: ((marker: WindowsAliasMarker) => void) | null = null;

  async list(_operation: ProviderConnectionOperation): Promise<readonly WindowsAliasMarker[]> {
    return Object.freeze([...this.markers.values()]);
  }

  async write(
    marker: WindowsAliasMarker,
    requestedOperation: ProviderConnectionOperation,
  ): Promise<void> {
    this.writes.push(marker);
    this.writeOperations.push(requestedOperation);
    this.markers.set(marker.drive, marker);
    this.onWrite?.(marker);
  }

  async remove(drive: string, requestedOperation: ProviderConnectionOperation): Promise<void> {
    this.removeCalls.push(drive);
    this.removeOperations.push(requestedOperation);
    this.markers.delete(drive);
  }
}

const harness = () => {
  const mappings = new SubstMappings();
  const markers = new Markers();
  let currentBinding: CliRuntimeBinding = binding;
  let revalidationCalls = 0;
  return {
    mappings,
    markers,
    aliases: createWindowsWorkspaceAliasForTest({
      knownFolders,
      providerRuntimeRoot: runtimeRoot,
      mappings,
      markers,
      inspector: {
        revalidate: async (_binding, _operation) => {
          revalidationCalls += 1;
          return currentBinding;
        },
      },
    }),
    revalidationCalls: () => revalidationCalls,
    returnBinding: (value: CliRuntimeBinding) => {
      currentBinding = value;
    },
  };
};

describe('Windows workspace alias leases', () => {
  it('persists only strict mapping markers below the runtime marker root', async () => {
    const temporaryRoot = await mkdtemp(win32.join(tmpdir(), 'studyapp-alias-marker-'));
    const temporaryRuntimeRoot = win32.join(temporaryRoot, 'providers');
    const reparseChecks: string[] = [];
    const store = createWindowsAliasMarkerStoreForTest({
      providerRuntimeRoot: temporaryRuntimeRoot,
      files: {
        canonicalize: async (path) => path,
        assertNoReparsePoints: async (path) => {
          reparseChecks.push(path);
        },
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
    });
    const marker = Object.freeze({
      kind: 'runtime' as const,
      drive: 'R:',
      target: temporaryRuntimeRoot,
      bindingSha256: null,
    });
    try {
      await store.write(marker, operation);
      await expect(store.list(operation)).resolves.toEqual([marker]);
      expect(store.root).toBe(win32.join(temporaryRuntimeRoot, 'alias-markers'));
      expect(reparseChecks).toContain(store.root);
      await store.remove('R:', operation);
      await expect(store.list(operation)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed marker contents without using their target', async () => {
    const temporaryRoot = await mkdtemp(win32.join(tmpdir(), 'studyapp-alias-marker-'));
    const temporaryRuntimeRoot = win32.join(temporaryRoot, 'providers');
    const store = createWindowsAliasMarkerStoreForTest({
      providerRuntimeRoot: temporaryRuntimeRoot,
      files: {
        canonicalize: async (path) => path,
        assertNoReparsePoints: async () => {},
        readFile: async () => new Uint8Array(),
        listChildren: async () => [],
      },
    });
    try {
      await store.write(
        {
          kind: 'runtime',
          drive: 'R:',
          target: temporaryRuntimeRoot,
          bindingSha256: null,
        },
        operation,
      );
      await writeFile(win32.join(store.root, 'R.json'), '{"target":"C:\\\\foreign"}', 'utf8');

      await expect(store.list(operation)).rejects.toMatchObject({
        code: 'PROVIDER_RESIDUAL_DATA',
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('uses the first free R: through W: drives for exact runtime and install targets', async () => {
    const setup = harness();
    setup.mappings.mappings.set('R:', 'C:\\foreign');

    const lease = await setup.aliases.acquire(binding, operation);

    expect(WINDOWS_ALIAS_DRIVES).toEqual(['R:', 'S:', 'T:', 'U:', 'V:', 'W:']);
    expect(setup.mappings.mapCalls).toEqual([
      ['S:', runtimeRoot],
      ['T:', geminiRoot],
    ]);
    expect(lease.launcherPath).toBe(binding.canonicalLauncherPath);
    expect(lease.fixedPrefixArgs).toEqual(['T:\\dist\\index.js']);
    expect(lease.profileRoot).toBe('S:\\profiles\\gemini_cli');
    expect(lease.rewritePath(`${runtimeRoot}\\workspace\\id`)).toBe('S:\\workspace\\id');
    expect(JSON.stringify(lease)).not.toContain(userProfile);
    expect(setup.mappings.mapOperations).toEqual([operation, operation]);
    expect(setup.mappings.listOperations.every((value) => value === operation)).toBe(true);
    expect(setup.markers.writeOperations).toEqual([operation, operation]);
  });

  it('rolls back an alias-map cancellation with one fresh bounded cleanup operation', async () => {
    const setup = harness();
    const controller = new AbortController();
    const userOperation = Object.freeze({
      requestId: '30000000-0000-4000-8000-000000000002',
      signal: controller.signal,
    }) satisfies ProviderConnectionOperation;
    setup.markers.onWrite = () => controller.abort();

    await expect(setup.aliases.acquire(binding, userOperation)).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });

    expect(setup.mappings.unmapCalls).toEqual([['R:', runtimeRoot]]);
    expect(setup.markers.removeCalls).toEqual(['R:']);
    const cleanupOperation = setup.mappings.unmapOperations[0];
    expect(cleanupOperation).toBeDefined();
    expect(cleanupOperation).not.toBe(userOperation);
    expect(cleanupOperation?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(cleanupOperation?.signal).not.toBe(userOperation.signal);
    expect(cleanupOperation?.signal.aborted).toBe(false);
    expect(setup.markers.removeOperations).toEqual([cleanupOperation]);
  });

  it.each([
    `--schema=${runtimeRoot}\\workspace\\request\\schema.json`,
    `--schema=${runtimeRoot.replaceAll('\\', '/').toUpperCase()}/profiles/gemini_cli/settings.json`,
    `prefix=//?/${userProfile.replaceAll('\\', '/')}\\Documents\\private.txt`,
    `--entry=${geminiRoot}\\dist\\index.js`,
  ])('rejects every unaliased private canonical-root representation in %s', async (value) => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);
    let failure: unknown;

    try {
      (
        lease as WindowsWorkspaceAliasLease & {
          assertNoCanonicalPathDisclosure(value: string): void;
        }
      ).assertNoCanonicalPathDisclosure(value);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
    await lease.release();
  });

  it('reference-counts shared mappings and unmaps only after the final lease', async () => {
    const setup = harness();
    const first = await setup.aliases.acquire(binding, operation);
    const second = await setup.aliases.acquire(binding, operation);

    expect(setup.mappings.mapCalls).toHaveLength(2);
    await first.release();
    expect(setup.mappings.unmapCalls).toHaveLength(0);
    await second.release();
    expect(setup.mappings.unmapCalls).toEqual([
      ['S:', geminiRoot],
      ['R:', runtimeRoot],
    ]);
    const cleanupOperation = setup.mappings.unmapOperations[0];
    expect(cleanupOperation).toBeDefined();
    expect(setup.mappings.unmapOperations).toEqual([cleanupOperation, cleanupOperation]);
    expect(setup.markers.removeOperations).toEqual([cleanupOperation, cleanupOperation]);
    expect(cleanupOperation).not.toBe(operation);
    expect(cleanupOperation?.requestId).not.toBe(operation.requestId);
    expect(cleanupOperation?.signal).not.toBe(operation.signal);
    expect(cleanupOperation?.signal.aborted).toBe(false);
  });

  it('fails closed without unmapping when a live lease target changes', async () => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);
    setup.mappings.mappings.set('R:', 'C:\\foreign');

    await expect(lease.revalidate(operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(setup.mappings.unmapCalls).toHaveLength(0);
  });

  it('attempts runtime unmap even when the install unmap fails', async () => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);
    setup.mappings.failUnmapTarget = geminiRoot;

    await expect(lease.release()).rejects.toBeInstanceOf(Error);

    expect(setup.mappings.unmapCalls).toEqual([
      ['S:', geminiRoot],
      ['R:', runtimeRoot],
    ]);
  });

  it('bounds a never-settling release and fails closed after five seconds', async () => {
    vi.useFakeTimers();
    const timeoutControllers: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      timeoutControllers.push(controller);
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const setup = harness();
      const lease = await setup.aliases.acquire(binding, operation);
      setup.mappings.hangUnmapTarget = geminiRoot;
      let settled = false;
      const pending = lease.release().finally(() => {
        settled = true;
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'PROVIDER_RESIDUAL_DATA',
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;

      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      expect(timeoutControllers).toHaveLength(1);
      expect(timeoutControllers[0]?.signal.aborted).toBe(true);
      expect(setup.mappings.unmapOperations[0]?.signal).toBe(timeoutControllers[0]?.signal);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('poisons the alias manager after an unmap failure instead of reusing an unverified mapping', async () => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);
    setup.mappings.failUnmapTarget = geminiRoot;
    await expect(lease.release()).rejects.toMatchObject({ code: 'PROVIDER_RESIDUAL_DATA' });
    const mapCalls = setup.mappings.mapCalls.length;

    await expect(setup.aliases.acquire(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(setup.mappings.mapCalls).toHaveLength(mapCalls);
  });

  it('uses the smallest common verified install ancestor for hoisted Codex packages', async () => {
    const setup = harness();
    const openAiRoot = `${userProfile}\\AppData\\Roaming\\npm\\node_modules\\@openai`;
    const codex = Object.freeze({
      ...binding,
      providerId: 'codex_cli' as const,
      canonicalLauncherPath: `${openAiRoot}\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`,
      canonicalEntryPath: `${openAiRoot}\\codex\\bin\\codex.js`,
      canonicalPackageManifestPath: `${openAiRoot}\\codex\\package.json`,
      canonicalPlatformPackageManifestPath: `${openAiRoot}\\codex-win32-x64\\package.json`,
      fixedPrefixArgs: Object.freeze([]),
      version: parseSafeSemVer('0.146.0'),
      platformPackageManifestSha256: 'e'.repeat(64),
      recipeId: 'codex-0.146-profile-keyring-v2',
      credentialScope: 'profile_scoped',
      signerClassification: 'openai' as const,
    }) satisfies CliRuntimeBinding<'codex_cli', 'profile_scoped'>;

    const lease = await setup.aliases.acquire(codex, operation);

    expect(setup.mappings.mapCalls[1]).toEqual(['S:', openAiRoot]);
    expect(lease.launcherPath).toMatch(/^S:\\/u);
    expect(lease.launcherPath).not.toContain(userProfile);
  });

  it('stores markers only below the runtime root and never mutates mapped targets', async () => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);

    expect(setup.markers.root).toBe(win32.join(runtimeRoot, 'alias-markers'));
    expect(setup.markers.writes).toEqual([
      { kind: 'runtime', drive: 'R:', target: runtimeRoot, bindingSha256: null },
      { kind: 'install', drive: 'S:', target: geminiRoot, bindingSha256: binding.bindingSha256 },
    ]);
    await lease.release();
  });

  it('cleans a stale runtime mapping only for the exact current runtime target', async () => {
    const setup = harness();
    setup.mappings.mappings.set('R:', runtimeRoot);
    setup.mappings.mappings.set('S:', 'C:\\foreign');
    setup.markers.markers.set('R:', {
      kind: 'runtime',
      drive: 'R:',
      target: runtimeRoot,
      bindingSha256: null,
    });
    setup.markers.markers.set('S:', {
      kind: 'runtime',
      drive: 'S:',
      target: runtimeRoot,
      bindingSha256: null,
    });

    await setup.aliases.cleanupStale(binding, operation);

    expect(setup.mappings.unmapCalls).toEqual([['R:', runtimeRoot]]);
    expect(setup.mappings.mappings.get('S:')).toBe('C:\\foreign');
    expect(setup.revalidationCalls()).toBe(1);
  });

  it('cleans a stale install mapping only when a fresh binding and marker prove the target', async () => {
    const setup = harness();
    setup.mappings.mappings.set('W:', geminiRoot);
    setup.markers.markers.set('W:', {
      kind: 'install',
      drive: 'W:',
      target: geminiRoot,
      bindingSha256: binding.bindingSha256,
    });

    await setup.aliases.cleanupStale(binding, operation);

    expect(setup.mappings.unmapCalls).toEqual([['W:', geminiRoot]]);
  });

  it('never unmaps a foreign or marker-mismatched install mapping', async () => {
    const setup = harness();
    setup.mappings.mappings.set('W:', geminiRoot);
    setup.markers.markers.set('W:', {
      kind: 'install',
      drive: 'W:',
      target: geminiRoot,
      bindingSha256: 'f'.repeat(64),
    });

    await setup.aliases.cleanupStale(binding, operation);

    expect(setup.mappings.unmapCalls).toHaveLength(0);
  });

  it('removes an orphan marker without touching any mapped target', async () => {
    const setup = harness();
    setup.markers.markers.set('W:', {
      kind: 'runtime',
      drive: 'W:',
      target: runtimeRoot,
      bindingSha256: null,
    });

    await setup.aliases.cleanupStale(binding, operation);

    expect(setup.mappings.unmapCalls).toHaveLength(0);
    expect(setup.markers.markers.has('W:')).toBe(false);
  });

  it('requires a complete fresh binding revalidation before stale cleanup', async () => {
    const setup = harness();
    setup.mappings.mappings.set('W:', geminiRoot);
    setup.markers.markers.set('W:', {
      kind: 'install',
      drive: 'W:',
      target: geminiRoot,
      bindingSha256: binding.bindingSha256,
    });
    setup.returnBinding(
      Object.freeze({
        ...binding,
        canonicalEntryPath: `${binding.canonicalEntryPath}.changed`,
      }),
    );

    await expect(setup.aliases.cleanupStale(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_CLI_CHANGED',
    });
    expect(setup.mappings.unmapCalls).toHaveLength(0);
  });

  it('does not treat a mapping leased by this process as stale', async () => {
    const setup = harness();
    const lease = await setup.aliases.acquire(binding, operation);

    await setup.aliases.cleanupStale(binding, operation);

    expect(setup.mappings.unmapCalls).toHaveLength(0);
    await lease.release();
  });

  it('fails closed when all fixed drive letters are occupied', async () => {
    const setup = harness();
    for (const drive of WINDOWS_ALIAS_DRIVES) setup.mappings.mappings.set(drive, 'C:\\foreign');

    await expect(setup.aliases.acquire(binding, operation)).rejects.toMatchObject({
      code: 'PROVIDER_RESIDUAL_DATA',
    });
    expect(setup.mappings.mapCalls).toHaveLength(0);
  });
});
