import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderFileBlock } from '../../../../src/core/ports/aiProvider';
import { ProviderSourceMaterializer } from '../../../../src/infrastructure/providers/providerSourceMaterializer';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'provider-media-test-'));
  roots.push(root);
  const bytes = Buffer.from([255, 216, 255, 224, 0, 0, 255, 217]);
  const filePath = join(root, 'private-original.jpg');
  await writeFile(filePath, bytes);
  const block: ProviderFileBlock = {
    role: 'user',
    kind: 'source_file',
    sourceId: randomUUID(),
    filePath,
    mediaType: 'image',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return {
    root,
    bytes,
    block,
    materializer: new ProviderSourceMaterializer(join(root, 'private')),
  };
};

it('copies only declared verified files under generated names and cleanup preserves originals', async () => {
  const { root, bytes, block, materializer } = await fixture();
  await writeFile(join(root, 'undeclared.txt'), 'secret');
  const id = randomUUID();
  const result = await materializer.materialize(id, [block]);
  expect(result.files[0]).toMatchObject({
    sourceId: block.sourceId,
    relativePath: 'sources/000-image.jpg',
  });
  const materialized = result.files[0];
  if (!materialized) throw new Error('missing test output');
  expect(await readFile(materialized.absolutePath)).toEqual(bytes);
  expect(await readdir(join(result.workspacePath, 'sources'))).toEqual(['000-image.jpg']);
  await materializer.cleanup(id);
  expect(await readdir(join(root, 'private'))).toEqual([]);
  expect(await readFile(block.filePath)).toEqual(bytes);
});

it.each(['sha256', 'sizeBytes'] as const)(
  'rejects changed %s and removes partial workspace',
  async (field) => {
    const { root, block, materializer } = await fixture();
    const changed = {
      ...block,
      [field]: field === 'sha256' ? '0'.repeat(64) : block.sizeBytes + 1,
    };
    await expect(materializer.materialize(randomUUID(), [changed])).rejects.toMatchObject({
      code: 'PROVIDER_EXECUTION_FAILED',
    });
    expect(await readdir(join(root, 'private'))).toEqual([]);
  },
);

it('rejects a pre-aborted operation before creating a workspace', async () => {
  const { block, materializer } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    materializer.materialize(randomUUID(), [block], controller.signal),
  ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
});

it('rejects a junction ancestor before reading or copying its target', async () => {
  const { root, block, materializer } = await fixture();
  const actual = join(root, 'actual');
  await mkdir(actual);
  await writeFile(join(actual, 'source.jpg'), 'private');
  const junction = join(root, 'junction');
  await symlink(actual, junction, 'junction');
  await expect(
    materializer.materialize(randomUUID(), [{ ...block, filePath: join(junction, 'source.jpg') }]),
  ).rejects.toMatchObject({ code: 'PROVIDER_EXECUTION_FAILED' });
  expect(await readdir(join(root, 'private'))).toEqual([]);
});

it('reserves a request ID across asynchronous workspace preparation', async () => {
  const { block, materializer } = await fixture();
  const id = randomUUID();
  const first = materializer.materialize(id, [block]);
  await expect(materializer.materialize(id, [block])).rejects.toMatchObject({
    code: 'PROVIDER_EXECUTION_FAILED',
  });
  await first;
  await materializer.cleanup(id);
  await materializer.cleanup(id);
});

it('rejects oversized metadata and unsupported extensions before creating a workspace', async () => {
  const { block, materializer } = await fixture();
  await expect(
    materializer.materialize(randomUUID(), [{ ...block, sizeBytes: 2_000_000_000 }]),
  ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TOO_LARGE' });
  await expect(
    materializer.materialize(randomUUID(), [{ ...block, filePath: 'C:\\unread\\image.heic' }]),
  ).rejects.toMatchObject({ code: 'PROVIDER_MEDIA_UNSUPPORTED' });
});

it('awaits private ACL verification on only its new empty workspace before creating sources', async () => {
  const { root, block } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let target = '';
  const secure = vi.fn(async (path: string) => {
    target = path;
    entered();
    await gate;
  });
  const materializer = new ProviderSourceMaterializer(join(root, 'private'), { acl: { secure } });
  const id = randomUUID();
  const pending = materializer.materialize(id, [block]);
  await ready;
  expect(target.startsWith(join(root, 'private', 'request-'))).toBe(true);
  expect(await readdir(target)).toEqual([]);
  release();
  const result = await pending;
  expect(result.files).toHaveLength(1);
  expect(secure).toHaveBeenCalledOnce();
  await materializer.cleanup(id);
});

it('writes no source data when restrictive ACL installation or verification fails', async () => {
  const { root, block } = await fixture();
  const secure = vi.fn(async (path: string) => {
    expect(await readdir(path)).toEqual([]);
    throw new Error('ACL verification failed');
  });
  const materializer = new ProviderSourceMaterializer(join(root, 'private'), { acl: { secure } });
  await expect(materializer.materialize(randomUUID(), [block])).rejects.toMatchObject({
    code: 'PROVIDER_EXECUTION_FAILED',
  });
  expect(secure).toHaveBeenCalledOnce();
  expect(await readdir(join(root, 'private'))).toEqual([]);
});
