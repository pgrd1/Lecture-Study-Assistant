import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertNoReparsePoints, resolveManagedPath } from '../../core/paths/safePath';
import type { PipelineArtifactRepository } from '../../core/ports/pipelineArtifactRepository';
import type {
  PipelineArtifactStore,
  PipelineArtifactWriteOptions,
} from '../../core/ports/pipelineArtifactStore';
import { sha256CanonicalJson } from '../../core/providers/canonicalJson';
import {
  assertBoundedPipelineJson,
  PIPELINE_ARTIFACT_MAX_BYTES,
  type PipelineArtifact,
  type PipelineArtifactIdentity,
  PipelineArtifactIdentitySchema,
  type PipelineArtifactRead,
  PipelineArtifactSchema,
  type PipelineArtifactWrite,
  PipelineArtifactWriteSchema,
  type PipelineStage,
  PipelineStageSchema,
} from '../../shared/contracts/pipelineArtifact';

const invalid = (): never => {
  throw new TypeError('INVALID_PIPELINE_ARTIFACT');
};
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new TypeError('PIPELINE_ARTIFACT_CANCELLED');
};

// Only called on bounded, schema-parsed plain data, never untrusted provider objects.
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? invalid() : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
};

/** Local app-owned artifact root, independent of VaultConnection and user-selected Vaults. */
class JsonPipelineArtifactStore implements PipelineArtifactStore {
  constructor(
    private readonly root: string,
    private readonly rootStats: Stats,
    private readonly repository: PipelineArtifactRepository,
  ) {}

  async #guard(path: string): Promise<void> {
    assertNoReparsePoints(this.root);
    assertNoReparsePoints(path);
    const current = await lstat(this.root);
    if (!current.isDirectory() || !sameFile(current, this.rootStats)) invalid();
    if (resolve(await realpath(this.root)).toLowerCase() !== this.root.toLowerCase()) invalid();
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) invalid();
  }

  async #readBytes(path: string): Promise<Buffer> {
    await this.#guard(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > PIPELINE_ARTIFACT_MAX_BYTES)
      invalid();
    const handle = await open(path, 'r');
    try {
      const opened = await handle.stat();
      if (
        !sameFile(before, opened) ||
        !opened.isFile() ||
        opened.size > PIPELINE_ARTIFACT_MAX_BYTES
      )
        invalid();
      // Fixed allocation and explicit read limit also bound files growing after stat.
      const bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      await this.#guard(path);
      const after = await handle.stat();
      if (
        offset !== opened.size ||
        after.size !== opened.size ||
        !sameFile(opened, await lstat(path))
      )
        invalid();
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  async #removeOwnedTemp(path: string, owned: Stats): Promise<void> {
    try {
      await this.#guard(path);
      const current = await lstat(path);
      if (current.isFile() && !current.isSymbolicLink() && sameFile(current, owned))
        await unlink(path);
    } catch {
      // Leave an ignored temporary orphan when ownership/containment cannot be proven.
    }
  }

  async #publish(path: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    const temp = join(dirname(path), `.pipeline-${randomUUID()}.tmp`);
    await this.#guard(temp);
    cancelled(signal);
    const handle = await open(temp, 'wx', 0o600);
    const owned = await handle.stat();
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      cancelled(signal);
      await this.#guard(temp);
      await this.#guard(path);
      if (!sameFile(owned, await lstat(temp))) invalid();
      try {
        await link(temp, path);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      // A concurrent identical publisher is safe; a pre-existing corrupt file is never overwritten.
      if (!(await this.#readBytes(path)).equals(bytes)) invalid();
    } finally {
      await this.#removeOwnedTemp(temp, owned);
    }
  }

  async write(
    artifact: PipelineArtifactWrite,
    options: PipelineArtifactWriteOptions = {},
  ): Promise<PipelineArtifact> {
    try {
      return await this.#write(artifact, options);
    } catch {
      cancelled(options.signal);
      throw new TypeError('PIPELINE_ARTIFACT_WRITE_FAILED');
    }
  }

  async #write(
    artifact: PipelineArtifactWrite,
    options: PipelineArtifactWriteOptions,
  ): Promise<PipelineArtifact> {
    cancelled(options.signal);
    assertBoundedPipelineJson(artifact);
    const parsed = PipelineArtifactWriteSchema.parse(artifact);
    const bytes = Buffer.from(canonical(parsed), 'utf8');
    if (bytes.length > PIPELINE_ARTIFACT_MAX_BYTES) invalid();
    const sha256 = digest(bytes);
    const metadata = PipelineArtifactSchema.parse({
      jobId: parsed.jobId,
      stage: parsed.stage,
      schemaVersion: parsed.schemaVersion,
      relativePath: `${parsed.jobId}/${parsed.stage}-v${parsed.schemaVersion}-${sha256}.json`,
      sha256,
      identitySha256: sha256CanonicalJson(parsed.identity),
      createdAt: new Date().toISOString(),
    });
    const directory = resolveManagedPath(this.root, parsed.jobId);
    await this.#guard(directory);
    cancelled(options.signal);
    try {
      await mkdir(directory);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    const path = resolveManagedPath(
      this.root,
      parsed.jobId,
      metadata.relativePath.split('/')[1] as string,
    );
    await this.#publish(path, bytes, options.signal);
    cancelled(options.signal);
    // A rejected guard leaves only an unreferenced immutable payload; preserve the previous pointer.
    await options.beforeCommit?.();
    cancelled(options.signal);
    // The atomic SQL statement is the commit point. Never infer completion from file existence.
    return this.repository.put(metadata);
  }

  async read(
    jobId: string,
    stage: PipelineStage,
    expectedIdentity: PipelineArtifactIdentity,
    expectedSchemaVersion: 1 | 2 = 1,
  ): Promise<PipelineArtifactRead | null> {
    try {
      return await this.#read(jobId, stage, expectedIdentity, expectedSchemaVersion);
    } catch {
      throw new TypeError('PIPELINE_ARTIFACT_READ_FAILED');
    }
  }

  async #read(
    jobId: string,
    stage: PipelineStage,
    expectedIdentity: PipelineArtifactIdentity,
    expectedSchemaVersion: 1 | 2,
  ): Promise<PipelineArtifactRead | null> {
    const id = z.uuid().parse(jobId);
    const parsedStage = PipelineStageSchema.parse(stage);
    z.union([z.literal(1), z.literal(2)]).parse(expectedSchemaVersion);
    assertBoundedPipelineJson(expectedIdentity);
    const expected = PipelineArtifactIdentitySchema.parse(expectedIdentity);
    const raw = this.repository.get(id, parsedStage);
    if (raw === null) return null;
    const metadata = PipelineArtifactSchema.parse(raw);
    if (metadata.jobId !== id || metadata.stage !== parsedStage) invalid();
    if (metadata.schemaVersion !== expectedSchemaVersion) return null;
    const expectedHash = sha256CanonicalJson(expected);
    if (metadata.identitySha256 !== expectedHash) return null;
    const path = resolveManagedPath(this.root, id, metadata.relativePath.split('/')[1] as string);
    const bytes = await this.#readBytes(path);
    if (digest(bytes) !== metadata.sha256) invalid();
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertBoundedPipelineJson(decoded);
    const parsed = PipelineArtifactWriteSchema.parse(decoded);
    if (
      parsed.jobId !== id ||
      parsed.stage !== parsedStage ||
      parsed.schemaVersion !== metadata.schemaVersion ||
      sha256CanonicalJson(parsed.identity) !== expectedHash ||
      canonical(parsed) !== bytes.toString('utf8')
    )
      invalid();
    return Object.freeze({ ...metadata, ...parsed });
  }
}

export const createJsonPipelineArtifactStore = async (
  artifactRoot: string,
  repository: PipelineArtifactRepository,
): Promise<PipelineArtifactStore> => {
  if (!isAbsolute(artifactRoot) || artifactRoot.includes('\0')) invalid();
  const root = resolve(artifactRoot);
  // Uses the existing Windows containment/reparse validator; root must already be provisioned locally.
  resolveManagedPath(root, 'checkpoint-probe');
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) invalid();
  if (resolve(await realpath(root)).toLowerCase() !== root.toLowerCase()) invalid();
  return new JsonPipelineArtifactStore(root, stats, repository);
};
