import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConnectionOperation } from '../../../../../src/core/ports/aiProvider';
import {
  createNodeCliFileIntegrityForTest,
  type NodeCliDirectoryHandle,
  type NodeCliDirent,
  type NodeCliFileHandle,
  type NodeCliFileStat,
  type NodeCliFileSystemOperations,
} from '../../../../../src/infrastructure/providers/cli/nodeCliFileIntegrity';

const requestId = '50000000-0000-4000-8000-000000000001';
const filePath = 'C:\\Tools\\codex.exe';
const directoryPath = 'C:\\Tools';

const operation = (signal: AbortSignal = new AbortController().signal) =>
  Object.freeze({ requestId, signal }) satisfies ProviderConnectionOperation;

const unsafeVersion = (error: unknown): boolean => {
  expect(error).toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
  expect(String(error)).not.toContain('C:\\Tools');
  return true;
};

const makeStat = (
  kind: 'file' | 'directory' | 'symlink',
  size = 0,
  identity = 1,
): NodeCliFileStat =>
  Object.freeze({
    size,
    mtimeMs: identity,
    ctimeMs: identity,
    dev: identity,
    ino: identity,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  });

class FakeDirent implements NodeCliDirent {
  constructor(
    readonly name: string,
    readonly kind: 'file' | 'directory' | 'symlink' = 'file',
  ) {}

  isFile(): boolean {
    return this.kind === 'file';
  }

  isDirectory(): boolean {
    return this.kind === 'directory';
  }

  isSymbolicLink(): boolean {
    return this.kind === 'symlink';
  }
}

class FakeHandle implements NodeCliFileHandle {
  closed = false;

  constructor(
    readonly path: string,
    readonly fs: FakeFs,
  ) {}

  async stat(): Promise<NodeCliFileStat> {
    this.fs.calls.push(`handle.stat:${this.path}`);
    await this.fs.pause();
    return this.fs.statFor(this.path);
  }

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>> {
    this.fs.calls.push(`handle.read:${this.path}:${position}:${length}`);
    await this.fs.pause();
    const entry = this.fs.files.get(this.path);
    if (entry === undefined || entry.kind !== 'file') throw this.fs.missing();
    const available = Math.max(0, entry.content.byteLength - position);
    const requested = Math.min(length, available);
    const bytesRead =
      this.fs.zeroReadAtOrAfterPosition !== null && position >= this.fs.zeroReadAtOrAfterPosition
        ? 0
        : Math.min(requested, this.fs.maxBytesPerRead ?? requested);
    buffer.set(entry.content.slice(position, position + bytesRead), offset);
    this.fs.onRead?.();
    return Object.freeze({ bytesRead });
  }

  async close(): Promise<void> {
    this.fs.calls.push(`handle.close:${this.path}`);
    this.closed = true;
  }
}

class FakeDirectoryHandle implements NodeCliDirectoryHandle {
  closed = false;
  readCount = 0;

  constructor(
    readonly path: string,
    readonly fs: FakeFs,
  ) {}

  async read(): Promise<NodeCliDirent | null> {
    this.fs.calls.push(`dir.read:${this.path}:${this.readCount}`);
    await this.fs.pause();
    const entry = this.fs.files.get(this.path);
    if (entry === undefined || entry.kind !== 'directory') throw this.fs.missing();
    const value =
      this.fs.lazyDirectoryChildCount === null
        ? (entry.children[this.readCount] ?? null)
        : this.readCount < this.fs.lazyDirectoryChildCount
          ? new FakeDirent(`${this.readCount}.exe`)
          : null;
    this.readCount += 1;
    this.fs.onDirectoryRead?.(this.readCount, value);
    return value;
  }

  async close(): Promise<void> {
    this.fs.calls.push(`dir.close:${this.path}`);
    this.closed = true;
  }
}

type Entry = Readonly<{
  kind: 'file' | 'directory' | 'symlink';
  content: Uint8Array;
  identity: number;
  children: readonly FakeDirent[];
  realpath: string;
}>;

class FakeFs implements NodeCliFileSystemOperations {
  readonly files = new Map<string, Entry>();
  readonly handles: FakeHandle[] = [];
  readonly directoryHandles: FakeDirectoryHandle[] = [];
  readonly calls: string[] = [];
  beforeAwait: (() => void) | null = null;
  maxBytesPerRead: number | null = null;
  zeroReadAtOrAfterPosition: number | null = null;
  lazyDirectoryChildCount: number | null = null;
  onRead: (() => void) | null = null;
  onDirectoryRead: ((readCount: number, value: NodeCliDirent | null) => void) | null = null;
  directoryOpenError: unknown | null = null;
  missingErrorMessage = 'ENOENT';

  constructor() {
    this.addDirectory('C:\\');
    this.addDirectory(directoryPath);
    this.addFile(filePath, 'hello');
  }

  addDirectory(path: string, children: readonly FakeDirent[] = []): void {
    this.files.set(path, {
      kind: 'directory',
      content: new Uint8Array(),
      identity: 1,
      children,
      realpath: path,
    });
  }

  addFile(path: string, content: string, identity = 1): void {
    this.files.set(path, {
      kind: 'file',
      content: new TextEncoder().encode(content),
      identity,
      children: [],
      realpath: path,
    });
  }

  addSymlink(path: string): void {
    this.files.set(path, {
      kind: 'symlink',
      content: new Uint8Array(),
      identity: 1,
      children: [],
      realpath: path,
    });
  }

  mutateFile(path: string, content: string, identity = 2): void {
    this.addFile(path, content, identity);
  }

  missing(): Error & { code: 'ENOENT' } {
    return Object.assign(new Error(this.missingErrorMessage), { code: 'ENOENT' as const });
  }

  notDirectory(): Error & { code: 'ENOTDIR' } {
    return Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' as const });
  }

  statFor(path: string): NodeCliFileStat {
    const entry = this.files.get(path);
    if (entry === undefined) throw this.missing();
    return makeStat(entry.kind, entry.content.byteLength, entry.identity);
  }

  async pause(): Promise<void> {
    this.beforeAwait?.();
    await Promise.resolve();
  }

  async lstat(path: string): Promise<NodeCliFileStat> {
    this.calls.push(`lstat:${path}`);
    await this.pause();
    return this.statFor(path);
  }

  async realpath(path: string): Promise<string> {
    this.calls.push(`realpath:${path}`);
    await this.pause();
    const entry = this.files.get(path);
    if (entry === undefined) throw this.missing();
    return entry.realpath;
  }

  async open(path: string): Promise<NodeCliFileHandle> {
    this.calls.push(`open:${path}`);
    await this.pause();
    const entry = this.files.get(path);
    if (entry === undefined) throw this.missing();
    const handle = new FakeHandle(path, this);
    this.handles.push(handle);
    return handle;
  }

  async opendir(path: string): Promise<NodeCliDirectoryHandle> {
    this.calls.push(`opendir:${path}`);
    const handle = new FakeDirectoryHandle(path, this);
    this.directoryHandles.push(handle);
    await this.pause();
    if (this.directoryOpenError !== null) throw this.directoryOpenError;
    const entry = this.files.get(path);
    if (entry === undefined) throw this.missing();
    if (entry.kind !== 'directory') throw this.notDirectory();
    return handle;
  }
}

const abortAtAwait = (
  fs: FakeFs,
  controller: AbortController,
  call: string,
  occurrence = 1,
): void => {
  let seen = 0;
  fs.beforeAwait = () => {
    if (fs.calls.at(-1) !== call) return;
    seen += 1;
    if (seen === occurrence) controller.abort();
  };
};

const createHarness = () => {
  const fs = new FakeFs();
  return { fs, ...createNodeCliFileIntegrityForTest(fs) };
};

describe('node CLI file integrity', () => {
  it('canonicalizes regular Windows paths after root-to-leaf reparse and realpath checks', async () => {
    const { files, fs } = createHarness();

    await expect(files.canonicalize(filePath, operation())).resolves.toBe(filePath);

    expect(fs.calls).toEqual([
      'lstat:C:\\',
      'lstat:C:\\Tools',
      `lstat:${filePath}`,
      `realpath:${filePath}`,
      'lstat:C:\\',
      'lstat:C:\\Tools',
      `lstat:${filePath}`,
    ]);
  });

  it('preserves missing path identity but normalizes symlinks and noncanonical paths', async () => {
    const { files, fs } = createHarness();
    fs.addSymlink('C:\\Tools\\link.exe');

    await expect(files.canonicalize('C:\\Tools\\missing.exe', operation())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(files.canonicalize('C:\\Tools\\link.exe', operation())).rejects.toSatisfy(
      unsafeVersion,
    );
    await expect(files.canonicalize('C:\\Tools\\..\\codex.exe', operation())).rejects.toSatisfy(
      unsafeVersion,
    );
  });

  it('preserves missing path codes without leaking raw filesystem paths', async () => {
    {
      const { files, fs } = createHarness();
      fs.missingErrorMessage = `ENOENT: no such file or directory, lstat '${filePath}'`;

      const error = await files
        .canonicalize('C:\\Tools\\missing.exe', operation())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'ENOENT' });
      expect(String(error)).not.toContain('C:\\Tools');
    }

    {
      const { files, fs } = createHarness();
      fs.directoryOpenError = Object.assign(
        new Error(`ENOTDIR: not a directory, scandir '${directoryPath}'`),
        { code: 'ENOTDIR' as const },
      );

      const error = await files
        .listChildren(directoryPath, operation())
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'ENOTDIR' });
      expect(String(error)).not.toContain('C:\\Tools');
    }
  });

  it.each([
    'C:\\Tools\\codex.exe:payload',
    'C:\\CON\\codex.exe',
    'C:\\Tools\\COM¹.exe',
    'C:\\Tools\\LPT².exe',
    'C:\\Tools\\CONIN$\\codex.exe',
    'C:\\Tools\\CONOUT$\\codex.exe',
  ])('rejects unsafe Windows path segments before filesystem access: %s', async (unsafePath) => {
    const { files, fs } = createHarness();

    await expect(files.canonicalize(unsafePath, operation())).rejects.toSatisfy(unsafeVersion);
    expect(fs.calls).toEqual([]);
  });

  it('reads exactly the opened file snapshot, rejects drift and closes handles on failures', async () => {
    const { files, fs } = createHarness();

    await expect(files.readFile(filePath, 32, operation())).resolves.toEqual(
      new TextEncoder().encode('hello'),
    );
    expect(fs.handles.at(-1)?.closed).toBe(true);

    await expect(files.readFile(filePath, 4, operation())).rejects.toSatisfy(unsafeVersion);
    expect(fs.handles.at(-1)?.closed).toBe(true);

    fs.onRead = () => fs.mutateFile(filePath, 'changed', 2);
    await expect(files.readFile(filePath, 32, operation())).rejects.toSatisfy(unsafeVersion);
    expect(fs.handles.at(-1)?.closed).toBe(true);
  });

  it('accumulates legitimate partial reads for exact snapshots and hashes', async () => {
    const { files, hasher, fs } = createHarness();
    fs.maxBytesPerRead = 2;

    await expect(files.readFile(filePath, 32, operation())).resolves.toEqual(
      new TextEncoder().encode('hello'),
    );
    await expect(hasher.sha256(filePath, operation())).resolves.toBe(
      createHash('sha256').update('hello').digest('hex'),
    );

    expect(fs.handles).toHaveLength(2);
    expect(fs.handles.every((handle) => handle.closed)).toBe(true);
  });

  it('rejects a zero-byte read before the initial snapshot is complete and closes handles', async () => {
    for (const invokeIntegrity of [
      async (
        files: ReturnType<typeof createHarness>['files'],
        _hasher: ReturnType<typeof createHarness>['hasher'],
      ) => files.readFile(filePath, 32, operation()),
      async (
        _files: ReturnType<typeof createHarness>['files'],
        hasher: ReturnType<typeof createHarness>['hasher'],
      ) => hasher.sha256(filePath, operation()),
    ]) {
      const { files, hasher, fs } = createHarness();
      fs.maxBytesPerRead = 2;
      fs.zeroReadAtOrAfterPosition = 2;

      await expect(invokeIntegrity(files, hasher)).rejects.toSatisfy(unsafeVersion);
      expect(fs.handles).toHaveLength(1);
      expect(fs.handles[0]?.closed).toBe(true);
    }
  });

  it.each([
    ['append', 'hello!', 1],
    ['truncate', 'hell', 1],
    ['identity replacement', 'hello', 2],
  ] as const)(
    'detects %s during snapshot reads and closes the handle',
    async (_name, content, identity) => {
      const { files, fs } = createHarness();
      let mutated = false;
      fs.onRead = () => {
        if (mutated) return;
        mutated = true;
        fs.mutateFile(filePath, content, identity);
      };

      await expect(files.readFile(filePath, 32, operation())).rejects.toSatisfy(unsafeVersion);
      expect(fs.handles).toHaveLength(1);
      expect(fs.handles[0]?.closed).toBe(true);
    },
  );

  it.each([
    ['append', 'hello!', 1],
    ['truncate', 'hell', 1],
    ['identity replacement', 'hello', 2],
  ] as const)(
    'detects %s during hashing and closes the handle',
    async (_name, content, identity) => {
      const { hasher, fs } = createHarness();
      let mutated = false;
      fs.onRead = () => {
        if (mutated) return;
        mutated = true;
        fs.mutateFile(filePath, content, identity);
      };

      await expect(hasher.sha256(filePath, operation())).rejects.toSatisfy(unsafeVersion);
      expect(fs.handles).toHaveLength(1);
      expect(fs.handles[0]?.closed).toBe(true);
    },
  );

  it('rejects directories as files, empty files, and oversized files without leaking paths', async () => {
    const { files, fs } = createHarness();
    fs.addFile('C:\\Tools\\empty.exe', '');
    fs.addFile('C:\\Tools\\large.exe', '12345');

    await expect(files.readFile(directoryPath, 32, operation())).rejects.toSatisfy(unsafeVersion);
    await expect(files.readFile('C:\\Tools\\empty.exe', 32, operation())).rejects.toSatisfy(
      unsafeVersion,
    );
    await expect(files.readFile('C:\\Tools\\large.exe', 4, operation())).rejects.toSatisfy(
      unsafeVersion,
    );
  });

  it('rejects reparse point paths before opening files for reads and hashes', async () => {
    const { files, hasher, fs } = createHarness();
    const linkPath = 'C:\\Tools\\link.exe';
    fs.addSymlink(linkPath);

    await expect(files.readFile(linkPath, 32, operation())).rejects.toSatisfy(unsafeVersion);
    await expect(hasher.sha256(linkPath, operation())).rejects.toSatisfy(unsafeVersion);

    expect(fs.calls).not.toContain(`open:${linkPath}`);
  });

  it.each(['read', 'hash'] as const)(
    'revalidates the full path after a %s snapshot and closes the handle',
    async (mode) => {
      const { files, hasher, fs } = createHarness();
      let mutated = false;
      fs.onRead = () => {
        if (mutated) return;
        mutated = true;
        fs.addSymlink('C:\\');
      };

      const result =
        mode === 'read'
          ? files.readFile(filePath, 32, operation())
          : hasher.sha256(filePath, operation());
      await expect(result).rejects.toSatisfy(unsafeVersion);
      expect(fs.handles).toHaveLength(1);
      expect(fs.handles[0]?.closed).toBe(true);
    },
  );

  it('lists one directory level with deterministic case-insensitive Windows ordering', async () => {
    const { files, fs } = createHarness();
    fs.addDirectory(directoryPath, [
      new FakeDirent('z.exe'),
      new FakeDirent('É.exe'),
      new FakeDirent('A.exe'),
      new FakeDirent('nested', 'directory'),
      new FakeDirent('ä.exe'),
    ]);
    fs.addFile('C:\\Tools\\z.exe', 'z');
    fs.addFile('C:\\Tools\\É.exe', 'e');
    fs.addFile('C:\\Tools\\A.exe', 'a');
    fs.addDirectory('C:\\Tools\\nested');
    fs.addFile('C:\\Tools\\ä.exe', 'a');

    const children = await files.listChildren(directoryPath, operation());

    expect(children).toEqual([
      'C:\\Tools\\A.exe',
      'C:\\Tools\\nested',
      'C:\\Tools\\z.exe',
      'C:\\Tools\\ä.exe',
      'C:\\Tools\\É.exe',
    ]);
    expect(Object.isFrozen(children)).toBe(true);
  });

  it('rejects unsafe child names, symlink children, and oversized directory listings', async () => {
    const { files, fs } = createHarness();
    for (const children of [
      [new FakeDirent('..\\escape.exe')],
      [new FakeDirent('bad/name.exe')],
      [new FakeDirent('CON')],
      [new FakeDirent('COM¹.exe')],
      [new FakeDirent('LPT².exe')],
      [new FakeDirent('CONIN$')],
      [new FakeDirent('CONOUT$')],
      [new FakeDirent('trailing-dot.')],
      [new FakeDirent('trailing-space ')],
      [new FakeDirent('link.exe', 'symlink')],
      [new FakeDirent('A.exe'), new FakeDirent('a.EXE')],
    ]) {
      fs.addDirectory(directoryPath, children);
      await expect(files.listChildren(directoryPath, operation())).rejects.toSatisfy(unsafeVersion);
      if (fs.directoryHandles.length > 0) {
        expect(fs.directoryHandles.at(-1)?.closed).toBe(true);
      }
    }
  });

  it('stops directory enumeration at the first entry beyond the bounded limit', async () => {
    const { files, fs } = createHarness();
    fs.lazyDirectoryChildCount = 1_000_000;

    await expect(files.listChildren(directoryPath, operation())).rejects.toSatisfy(unsafeVersion);

    expect(fs.calls).toContain(`opendir:${directoryPath}`);
    expect(fs.directoryHandles).toHaveLength(1);
    expect(fs.directoryHandles[0]?.readCount).toBe(4_097);
    expect(fs.directoryHandles[0]?.closed).toBe(true);
  });

  it('revalidates the full directory path after enumeration and closes the handle', async () => {
    const { files, fs } = createHarness();
    fs.addDirectory(directoryPath, [new FakeDirent('child.exe')]);
    fs.addFile('C:\\Tools\\child.exe', 'child');
    fs.onDirectoryRead = (readCount, value) => {
      if (readCount === 1 && value !== null) fs.addSymlink('C:\\');
    };

    await expect(files.listChildren(directoryPath, operation())).rejects.toSatisfy(unsafeVersion);
    expect(fs.directoryHandles).toHaveLength(1);
    expect(fs.directoryHandles[0]?.closed).toBe(true);
  });

  it('preserves ENOTDIR returned by directory enumeration', async () => {
    const { files, fs } = createHarness();
    fs.directoryOpenError = fs.notDirectory();

    await expect(files.listChildren(directoryPath, operation())).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('hashes through bounded reads and returns lowercase sha256 without using readFile', async () => {
    const { hasher, fs } = createHarness();

    await expect(hasher.sha256(filePath, operation())).resolves.toBe(
      createHash('sha256').update('hello').digest('hex'),
    );

    expect(fs.calls.some((call) => call.startsWith('handle.read'))).toBe(true);
    expect(fs.handles.at(-1)?.closed).toBe(true);
  });

  it('checks pre-aborted operations before filesystem calls for every public method', async () => {
    const controller = new AbortController();
    controller.abort();
    const { files, hasher, fs } = createHarness();

    await expect(files.canonicalize(filePath, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    await expect(
      files.assertNoReparsePoints(filePath, operation(controller.signal)),
    ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
    await expect(files.readFile(filePath, 32, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    await expect(
      files.listChildren(directoryPath, operation(controller.signal)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    await expect(hasher.sha256(filePath, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(fs.calls).toEqual([]);
  });

  it('stops canonicalization and reparse walks immediately after an awaited cancellation', async () => {
    {
      const controller = new AbortController();
      const { files, fs } = createHarness();
      abortAtAwait(fs, controller, `realpath:${filePath}`);

      await expect(
        files.canonicalize(filePath, operation(controller.signal)),
      ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(fs.calls.at(-1)).toBe(`realpath:${filePath}`);
    }

    {
      const controller = new AbortController();
      const { files, fs } = createHarness();
      abortAtAwait(fs, controller, 'lstat:C:\\');

      await expect(
        files.assertNoReparsePoints(filePath, operation(controller.signal)),
      ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(fs.calls).toEqual(['lstat:C:\\']);
    }
  });

  it('stops after in-flight cancellation and closes an opened read handle', async () => {
    const controller = new AbortController();
    const { files, fs } = createHarness();
    fs.beforeAwait = () => {
      if (fs.calls.at(-1) === `open:${filePath}`) controller.abort();
    };

    await expect(files.readFile(filePath, 32, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(fs.calls).toContain(`open:${filePath}`);
    expect(fs.calls.at(-1)).toBe(`handle.close:${filePath}`);
    expect(fs.handles.at(-1)?.closed).toBe(true);
  });

  it('stops reads and hashes after a cancelled handle-read boundary and closes handles', async () => {
    for (const invokeIntegrity of [
      async (
        files: ReturnType<typeof createHarness>['files'],
        _hasher: ReturnType<typeof createHarness>['hasher'],
        signal: AbortSignal,
      ) => files.readFile(filePath, 32, operation(signal)),
      async (
        _files: ReturnType<typeof createHarness>['files'],
        hasher: ReturnType<typeof createHarness>['hasher'],
        signal: AbortSignal,
      ) => hasher.sha256(filePath, operation(signal)),
    ]) {
      const controller = new AbortController();
      const { files, hasher, fs } = createHarness();
      abortAtAwait(fs, controller, `handle.read:${filePath}:0:5`);

      await expect(invokeIntegrity(files, hasher, controller.signal)).rejects.toMatchObject({
        code: 'PROVIDER_CANCELLED',
      });
      expect(fs.calls.filter((call) => call.startsWith('handle.read:'))).toHaveLength(1);
      expect(fs.calls.at(-1)).toBe(`handle.close:${filePath}`);
      expect(fs.handles[0]?.closed).toBe(true);
    }
  });

  it.each(['open', 'read'] as const)(
    'closes a directory handle when cancellation arrives after directory %s',
    async (phase) => {
      const controller = new AbortController();
      const { files, fs } = createHarness();
      fs.addDirectory(directoryPath, [new FakeDirent('child.exe')]);
      fs.addFile('C:\\Tools\\child.exe', 'child');
      abortAtAwait(
        fs,
        controller,
        phase === 'open' ? `opendir:${directoryPath}` : `dir.read:${directoryPath}:0`,
      );

      await expect(
        files.listChildren(directoryPath, operation(controller.signal)),
      ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
      expect(fs.directoryHandles).toHaveLength(1);
      expect(fs.directoryHandles[0]?.closed).toBe(true);
      if (phase === 'open') {
        expect(fs.calls.some((call) => call.startsWith('dir.read:'))).toBe(false);
      } else {
        expect(fs.calls.filter((call) => call.startsWith('dir.read:'))).toHaveLength(1);
      }
    },
  );

  it('stops after in-flight cancellation before later list or hash work', async () => {
    const controller = new AbortController();
    const { files, hasher, fs } = createHarness();
    fs.beforeAwait = () => controller.abort();

    await expect(
      files.listChildren(directoryPath, operation(controller.signal)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(fs.calls).toEqual(['lstat:C:\\']);

    fs.calls.length = 0;
    controller.abort();
    await expect(hasher.sha256(filePath, operation(controller.signal))).rejects.toMatchObject({
      code: 'PROVIDER_CANCELLED',
    });
    expect(fs.calls).toEqual([]);
  });
});
