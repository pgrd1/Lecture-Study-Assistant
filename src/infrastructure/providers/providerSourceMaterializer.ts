import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { ProviderFileBlock } from '../../core/ports/aiProvider';
import { APP_ERROR_MESSAGES, AppError, type ProviderErrorCode } from '../../shared/errors';
import { createBoundedNodeProcessRunner } from './cli/boundedNodeProcessRunner';
import {
  createWindowsPrivateDirectoryAcl,
  type WindowsPrivateDirectoryAcl,
} from './cli/cliPrivateDirectories';
import {
  createNodeCliExecutableFileAccess,
  createNodeCliFileHasher,
} from './cli/nodeCliFileIntegrity';

export const mediaError = (code: ProviderErrorCode = 'PROVIDER_MEDIA_UNSUPPORTED'): AppError =>
  new AppError(code, APP_ERROR_MESSAGES[code]);
export const assertMediaActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw mediaError('PROVIDER_CANCELLED');
};
const RAW_CEILING = 64_000_000;
const FORMATS: Readonly<Record<string, readonly [ProviderFileBlock['mediaType'], string]>> = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.pdf': ['document', 'application/pdf'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.wav': ['audio', 'audio/wav'],
  '.m4a': ['audio', 'audio/m4a'],
};
export const sourceMime = (block: ProviderFileBlock): string => {
  const format = FORMATS[extname(block.filePath).toLowerCase()];
  if (!format || format[0] !== block.mediaType) throw mediaError();
  return format[1];
};
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const assertPath = async (path: string): Promise<void> => {
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    (process.platform === 'win32' && (!/^[a-z]:[\\/]/iu.test(path) || path.slice(2).includes(':')))
  )
    throw mediaError('PROVIDER_EXECUTION_FAILED');
  let current = resolve(path);
  while (current !== parse(current).root) {
    if ((await lstat(current)).isSymbolicLink()) throw mediaError('PROVIDER_EXECUTION_FAILED');
    current = dirname(current);
  }
  if (resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
    throw mediaError('PROVIDER_EXECUTION_FAILED');
};
export const readVerifiedSource = async (
  block: ProviderFileBlock,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertMediaActive(signal);
  if (
    !Number.isSafeInteger(block.sizeBytes) ||
    block.sizeBytes < 1 ||
    block.sizeBytes > RAW_CEILING
  )
    throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
  await assertPath(block.filePath);
  const before = await lstat(block.filePath);
  if (!before.isFile() || before.size !== block.sizeBytes)
    throw mediaError('PROVIDER_EXECUTION_FAILED');
  // POSIX denies following the leaf atomically. Windows also checks every ancestor,
  // path/handle identity before any read, and the complete snapshot after reading.
  const handle = await open(block.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(before, await handle.stat())) throw mediaError('PROVIDER_EXECUTION_FAILED');
    const bytes = Buffer.alloc(block.sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      assertMediaActive(signal);
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(65_536, bytes.length - offset),
        offset,
      );
      if (bytesRead === 0) throw mediaError('PROVIDER_EXECUTION_FAILED');
      offset += bytesRead;
    }
    const probe = await handle.read(Buffer.alloc(1), 0, 1, offset);
    await assertPath(block.filePath);
    if (
      probe.bytesRead !== 0 ||
      !same(before, await handle.stat()) ||
      !same(before, await lstat(block.filePath)) ||
      createHash('sha256').update(bytes).digest('hex') !== block.sha256
    )
      throw mediaError('PROVIDER_EXECUTION_FAILED');
    assertMediaActive(signal);
    return bytes;
  } finally {
    await handle.close();
  }
};
export type MaterializedProviderFile = Readonly<
  ProviderFileBlock & { absolutePath: string; relativePath: string; mimeType: string }
>;
export interface ProviderSourceMaterializerPort {
  /** A rejection owns and cleans its partial preparation; callers acquire ownership only on resolve. */
  materialize(
    requestId: string,
    blocks: readonly ProviderFileBlock[],
    signal?: AbortSignal,
  ): Promise<Readonly<{ workspacePath: string; files: readonly MaterializedProviderFile[] }>>;
  cleanup(requestId: string): Promise<void>;
}
export class ProviderSourceMaterializer implements ProviderSourceMaterializerPort {
  readonly #root: string;
  readonly #workspaces = new Map<string, string>();
  readonly #pending = new Set<string>();
  readonly #acl: WindowsPrivateDirectoryAcl | undefined;
  constructor(
    root = join(tmpdir(), 'lecture-study-provider-media'),
    options: Readonly<{ acl?: WindowsPrivateDirectoryAcl }> = {},
  ) {
    this.#root = resolve(root);
    this.#acl =
      options.acl ??
      (process.platform === 'win32'
        ? createWindowsPrivateDirectoryAcl({
            runner: createBoundedNodeProcessRunner(),
            files: createNodeCliExecutableFileAccess(),
            hasher: createNodeCliFileHasher(),
          })
        : undefined);
  }
  async materialize(requestId: string, blocks: readonly ProviderFileBlock[], signal?: AbortSignal) {
    assertMediaActive(signal);
    if (
      !/^[0-9a-f-]{36}$/iu.test(requestId) ||
      this.#workspaces.has(requestId) ||
      this.#pending.has(requestId)
    )
      throw mediaError('PROVIDER_EXECUTION_FAILED');
    if (
      blocks.length > 20 ||
      blocks.reduce((total, block) => total + block.sizeBytes, 0) > RAW_CEILING
    )
      throw mediaError('PROVIDER_REQUEST_TOO_LARGE');
    blocks.forEach(sourceMime);
    this.#pending.add(requestId);
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await assertPath(this.#root);
      assertMediaActive(signal);
      const workspacePath = await mkdtemp(join(this.#root, 'request-'));
      this.#workspaces.set(requestId, workspacePath);
      await assertPath(workspacePath);
      // Only this newly owned empty directory is changed, never the injected/shared root.
      // The ACL helper protects inheritance, grants current SID/SYSTEM only, and reads it back.
      await this.#acl?.secure(workspacePath, {
        requestId,
        signal: signal ?? new AbortController().signal,
      });
      assertMediaActive(signal);
      await assertPath(workspacePath);
      await mkdir(join(workspacePath, 'sources'), { mode: 0o700 });
      const files: MaterializedProviderFile[] = [];
      for (const [index, block] of blocks.entries()) {
        const sourceBefore = await lstat(block.filePath);
        const bytes = await readVerifiedSource(block, signal);
        const relativePath = `sources/${String(index).padStart(3, '0')}-${block.mediaType}${extname(block.filePath).toLowerCase()}`;
        const absolutePath = join(workspacePath, relativePath);
        const destination = await open(absolutePath, 'wx', 0o600);
        try {
          await destination.writeFile(bytes);
        } finally {
          await destination.close();
        }
        assertMediaActive(signal);
        await assertPath(block.filePath);
        if (!same(sourceBefore, await lstat(block.filePath)))
          throw mediaError('PROVIDER_EXECUTION_FAILED');
        files.push(
          Object.freeze({ ...block, relativePath, absolutePath, mimeType: sourceMime(block) }),
        );
      }
      return Object.freeze({ workspacePath, files: Object.freeze(files) });
    } catch (error) {
      await this.cleanup(requestId);
      if (AppError.isTrusted(error)) throw error;
      throw mediaError('PROVIDER_EXECUTION_FAILED');
    } finally {
      this.#pending.delete(requestId);
    }
  }
  async cleanup(requestId: string): Promise<void> {
    const path = this.#workspaces.get(requestId);
    if (!path) return;
    const child = relative(this.#root, path);
    if (!child.startsWith('request-') || child.includes('/') || child.includes('\\'))
      throw mediaError('PROVIDER_RESIDUAL_DATA');
    try {
      await assertPath(path);
      await rm(path, { recursive: true, force: false });
      this.#workspaces.delete(requestId);
    } catch {
      throw mediaError('PROVIDER_RESIDUAL_DATA');
    }
  }
}
