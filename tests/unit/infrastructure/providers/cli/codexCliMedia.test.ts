import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderFileBlock } from '../../../../../src/core/ports/aiProvider';
import {
  preflightCodexMedia,
  prepareCodexImages,
} from '../../../../../src/infrastructure/providers/cli/codexCliMedia';
import { ProviderSourceMaterializer } from '../../../../../src/infrastructure/providers/providerSourceMaterializer';

const id = '123e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];
const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
  'hex',
);
const file = (path: string): ProviderFileBlock => ({
  role: 'user',
  kind: 'source_file',
  sourceId: id,
  filePath: path,
  mediaType: 'image',
  sizeBytes: png.length,
  sha256: createHash('sha256').update(png).digest('hex'),
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('native Codex declared images', () => {
  it.each(['valid', 'marker', 'length', 'missing-size'] as const)(
    'checks JPEG header dimensions and %s structure before disclosure',
    async (variant) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-media-jpeg-'));
      roots.push(root);
      const path = join(root, 'image.jpg');
      const bytes = Buffer.from('ffd8ffe000040000ffc0000b080001000101011100ffd9', 'hex');
      if (variant === 'marker') bytes[2] = 0;
      if (variant === 'length') bytes.writeUInt16BE(65535, 4);
      if (variant === 'missing-size') bytes[9] = 0xe1;
      await writeFile(path, bytes);
      const descriptor = {
        ...file(path),
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const pending = prepareCodexImages(
        id,
        [descriptor],
        new AbortController().signal,
        new ProviderSourceMaterializer(join(root, 'staging')),
      );
      if (variant === 'valid') expect(Buffer.from((await pending)[0]?.bytes ?? [])).toEqual(bytes);
      else await expect(pending).rejects.toThrow();
      expect(await readFile(path)).toEqual(bytes);
    },
  );
  it('refuses a source behind a junction while retaining its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-media-junction-'));
    roots.push(root);
    const target = join(root, 'target');
    await mkdir(target);
    await writeFile(join(target, 'image.png'), png);
    const alias = join(root, 'alias');
    await symlink(target, alias, 'junction');
    await expect(
      prepareCodexImages(
        id,
        [file(join(alias, 'image.png'))],
        new AbortController().signal,
        new ProviderSourceMaterializer(join(root, 'staging')),
      ),
    ).rejects.toThrow();
    expect(await readFile(join(target, 'image.png'))).toEqual(png);
  });
  it.each(['hash', 'size', 'signature', 'dimensions'] as const)(
    'rejects a %s mismatch and removes staging while preserving the original',
    async (mismatch) => {
      const root = await mkdtemp(join(tmpdir(), 'codex-media-invalid-'));
      roots.push(root);
      const path = join(root, 'original.png');
      const bytes = Buffer.from(png);
      if (mismatch === 'signature') bytes[0] = 0;
      if (mismatch === 'dimensions') bytes.writeUInt32BE(2049, 16);
      await writeFile(path, bytes);
      const descriptor = {
        ...file(path),
        sha256:
          mismatch === 'hash' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length + (mismatch === 'size' ? 1 : 0),
      };
      const materializer = new ProviderSourceMaterializer(join(root, 'staging'));
      await expect(
        prepareCodexImages(id, [descriptor], new AbortController().signal, materializer),
      ).rejects.toThrow();
      expect(await readFile(path)).toEqual(bytes);
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(join(root, 'staging'))).toEqual([]);
    },
  );

  it('does not clean a failed acquisition owned by another caller', async () => {
    let cleanup = false;
    await expect(
      prepareCodexImages(id, [file('C:\\missing.png')], new AbortController().signal, {
        materialize: async () => {
          throw new Error('duplicate');
        },
        cleanup: async () => {
          cleanup = true;
        },
      }),
    ).rejects.toThrow('duplicate');
    expect(cleanup).toBe(false);
  });

  it.each(['path', 'hash', 'size', 'count'] as const)(
    'rejects materializer %s descriptor drift before reading an undeclared path',
    async (mismatch) => {
      let cleaned = false;
      const declared = file('C:\\original.png');
      const result = {
        ...declared,
        relativePath: 'sources/000-image.png',
        absolutePath: 'C:\\managed\\sources\\000-image.png',
        mimeType: 'image/png',
      };
      const changed = {
        ...result,
        ...(mismatch === 'path'
          ? { absolutePath: 'C:\\foreign.png' }
          : mismatch === 'hash'
            ? { sha256: '0'.repeat(64) }
            : { sizeBytes: 1 }),
      };
      await expect(
        prepareCodexImages(id, [declared], new AbortController().signal, {
          materialize: async () => ({
            workspacePath: 'C:\\managed',
            files: mismatch === 'count' ? [] : [changed],
          }),
          cleanup: async () => {
            cleaned = true;
          },
        }),
      ).rejects.toThrow();
      expect(cleaned).toBe(true);
    },
  );

  it('rejects duplicate identities, excessive count and oversize metadata before access', () => {
    const source = file('C:\\missing.png');
    for (const blocks of [
      [source, source],
      [source, source, source],
      [{ ...source, sizeBytes: 5_000_001 }],
    ])
      expect(() => preflightCodexMedia('gpt-5.5-2026-04-23', blocks, {}, 1024)).toThrow();
  });
  it.each([null, 'unknown', 'gpt-4.1'])(
    'refuses unverified media model %s before source reads',
    (model) => {
      expect(() => preflightCodexMedia(model, [file('C:\\missing.png')], {}, 1024)).toThrow();
    },
  );
  it.each(['document', 'audio', 'video'] as const)('refuses %s without conversion', (mediaType) => {
    expect(() =>
      preflightCodexMedia(
        'gpt-5.5-2026-04-23',
        [{ ...file('C:\\missing.png'), mediaType }],
        {},
        1024,
      ),
    ).toThrow();
  });
  it('materializes only declared images with identical bytes/hash and removes private staging before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-media-test-'));
    roots.push(root);
    const path = join(root, 'original.png');
    await writeFile(path, png);
    const staging = new ProviderSourceMaterializer(join(root, 'staging'));
    const plan = preflightCodexMedia(
      'gpt-5.5-2026-04-23',
      [
        file(path),
        { role: 'user', kind: 'source', text: '@C:\\private.png --image C:\\secret.png' },
      ],
      {},
      1024,
    );
    const images = await prepareCodexImages(id, plan.files, new AbortController().signal, staging);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      fileName: 'image-000.png',
      sizeBytes: png.length,
      sha256: file(path).sha256,
    });
    expect(Buffer.from(images[0]?.bytes ?? [])).toEqual(png);
    expect(await readFile(path)).toEqual(png);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(root, 'staging'))).toEqual([]);
    expect(plan.text.some((block) => block.text.includes('--image'))).toBe(true);
  });
  it('bounds the complete escaped input before materialization', () => {
    expect(() =>
      preflightCodexMedia(
        'gpt-5.5-2026-04-23',
        [file('C:\\missing.png'), { role: 'user', kind: 'source', text: '\\'.repeat(40000) }],
        {},
        1024,
      ),
    ).toThrow();
  });
});
