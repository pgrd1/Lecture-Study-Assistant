import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMetadataWorker } from '../../../src/infrastructure/metadata/localSourceMetadata';
import { parseSourceMetadata } from '../../../src/infrastructure/metadata/parseSourceMetadata';
import {
  insertPng,
  jpegExif,
  jpegWithoutExif,
  pngChunk,
  progressiveJpeg,
  segment,
  spoofedImages,
} from '../../fixtures/metadata/imageStructures';
import { jpeg, png } from '../../fixtures/metadata/synthetic';

const input = (bytes: Buffer, extension = '.jpg') => ({
  bytes,
  extension,
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const parse = (bytes: Buffer, extension = '.jpg') => parseSourceMetadata(input(bytes, extension));
const worker = (bytes: Buffer, extension: string, timeoutMs = 1000) =>
  runMetadataWorker(input(bytes, extension), {
    workerPath: resolve('.vite/build/metadata-worker.mjs'),
    timeoutMs,
  });
describe('format-specific image metadata', () => {
  it.each([0, 1, 2])(
    'promptly rejects zero-length spoof family%i in every image extension and recovers',
    async (family) => {
      for (const extension of ['.png', '.jpg', '.jpeg']) {
        const suffix = extension === '.png' ? png.subarray(-12) : Buffer.from([255, 217]);
        const bytes = Buffer.concat([spoofedImages()[family] as Buffer, suffix]);
        await expect(worker(bytes, extension)).rejects.toMatchObject({ code: 'METADATA_INVALID' });
        await expect(worker(png, '.png')).resolves.toMatchObject({ encodedWidth: 1 });
      }
    },
    15000,
  );
  it.each([false, true])(
    'reads all8 EXIF orientations with endian=%s and preserves source hashes',
    async (be) => {
      for (let orientation = 1; orientation <= 8; orientation++) {
        const bytes = jpegExif(orientation, be);
        const hash = input(bytes).sha256;
        await expect(parse(bytes)).resolves.toMatchObject({
          orientation,
          encodedWidth: 30,
          encodedHeight: 20,
          displayWidth: orientation >= 5 ? 20 : 30,
          displayHeight: orientation >= 5 ? 30 : 20,
        });
        expect(input(bytes).sha256).toBe(hash);
      }
    },
  );
  it('accepts real baseline/no-EXIF and progressive JPEG with exact dimensions', async () => {
    expect(input(progressiveJpeg).sha256).toBe(
      'd88527174d495e30a83627281b0cf4d3230f425c3a49b69e8c08d889e32480f7',
    );
    for (const bytes of [jpegWithoutExif(), progressiveJpeg])
      await expect(parse(bytes)).resolves.toMatchObject({
        orientation: 1,
        encodedWidth: 30,
        encodedHeight: 20,
      });
  });
  it('rejects signature mismatch, post-EOI junk, truncated scans and malformed JPEG segments', async () => {
    for (const bytes of [
      Buffer.concat([png, Buffer.from([255, 217])]),
      Buffer.concat([jpeg(), Buffer.from([1, 255, 217])]),
      Buffer.concat([jpeg().subarray(0, -3), Buffer.from([255])]),
      Buffer.concat([Buffer.from([255, 216]), segment(0xe0), jpeg().subarray(2, -2)]),
      ...[0, 1, 65535].map((size) => {
        const b = jpeg();
        b.writeUInt16BE(size, 4);
        return b;
      }),
    ])
      await expect(parse(bytes)).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    await expect(parse(Buffer.concat([jpeg(), png.subarray(-12)]), '.png')).rejects.toMatchObject({
      code: 'METADATA_INVALID',
    });
  });
  it('rejects malformed EXIF byte order/magic/IFD bounds/type/count/orientation and duplicates', async () => {
    const changed = (offset: number, size: number, value: number) => {
      const b = jpeg();
      if (size === 2) b.writeUInt16LE(value, offset);
      else b.writeUInt32LE(value, offset);
      return b;
    };
    for (const bytes of [
      changed(12, 2, 0),
      changed(14, 2, 43),
      changed(16, 4, 0),
      changed(16, 4, 0xffffffff),
      changed(20, 2, 2),
      changed(24, 2, 4),
      changed(26, 4, 2),
      changed(30, 2, 0),
      changed(30, 2, 9),
      changed(34, 4, 8),
      Buffer.concat([jpeg().subarray(0, 38), jpeg(6).subarray(2)]),
      Buffer.concat([jpeg().subarray(0, 38), jpeg().subarray(2)]),
    ])
      await expect(parse(bytes)).rejects.toMatchObject({ code: 'METADATA_INVALID' });
  });
  it('checks full PNG envelope, IHDR length, critical chunks, eXIf, suffix and chunk lengths', async () => {
    for (const bytes of [
      Buffer.concat([Buffer.from('wrongpng'), png.subarray(8)]),
      Buffer.concat([png, png.subarray(-12)]),
      png.subarray(0, -1),
      insertPng(pngChunk('eXIf')),
      insertPng(pngChunk('ABCD')),
      insertPng(png.subarray(8, 33)),
      ...[0, 1, 0xffffffff].map((size) => {
        const b = Buffer.from(png);
        b.writeUInt32BE(size, 8);
        return b;
      }),
    ])
      await expect(parse(bytes, '.png')).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    for (const size of [0, 1])
      await expect(
        parse(insertPng(pngChunk('tEXt', Buffer.alloc(size))), '.png'),
      ).resolves.toMatchObject({ encodedWidth: 1 });
  });
  it('rejects zero/excessive dimensions and finite iteration exhaustion', async () => {
    for (const width of [0, 32769, 0xffffffff]) {
      const b = Buffer.from(png);
      b.writeUInt32BE(width, 16);
      await expect(parse(b, '.png')).rejects.toThrow();
    }
    const pixelOverflow = Buffer.from(png);
    pixelOverflow.writeUInt32BE(20000, 16);
    pixelOverflow.writeUInt32BE(20000, 20);
    await expect(parse(pixelOverflow, '.png')).rejects.toThrow();
    await expect(
      parse(insertPng(Buffer.concat(Array.from({ length: 4096 }, () => pngChunk('tEXt')))), '.png'),
    ).rejects.toMatchObject({ code: 'METADATA_LIMIT' });
    await expect(
      parse(
        Buffer.concat([
          jpeg().subarray(0, 2),
          ...Array.from({ length: 4096 }, () => segment(0xfe)),
          jpeg().subarray(2),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'METADATA_LIMIT' });
  });
  it('validates PNG IHDR methods, palette/data ordering and exact chunk names', async () => {
    const mutate = (at: number, value: number) => {
      const b = Buffer.from(png);
      b[at] = value;
      return b;
    };
    for (const bytes of [
      mutate(24, 3),
      mutate(25, 5),
      mutate(26, 1),
      mutate(27, 1),
      mutate(28, 2),
      mutate(12, 0xc9),
      insertPng(pngChunk('acTL')),
      insertPng(pngChunk('PLTE', Buffer.alloc(3))),
      insertPng(Buffer.concat([pngChunk('IDAT'), pngChunk('tEXt')])),
    ])
      await expect(parse(bytes, '.png')).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    const indexed = mutate(25, 3);
    await expect(parse(indexed, '.png')).rejects.toThrow();
    const withPalette = Buffer.concat([
      indexed.subarray(0, 33),
      pngChunk('PLTE', Buffer.alloc(3)),
      indexed.subarray(33),
    ]);
    await expect(parse(withPalette, '.png')).resolves.toMatchObject({ encodedWidth: 1 });
  });
  it('validates JPEG frame and scan headers, rejects unsupported markers, and traverses stuffed/restart bytes', async () => {
    const original = jpeg();
    const sof = original.indexOf(Buffer.from([255, 192]));
    const sos = original.indexOf(Buffer.from([255, 218]));
    const mutate = (at: number, value: number) => {
      const b = Buffer.from(original);
      b[at] = value;
      return b;
    };
    for (const bytes of [
      mutate(sof + 1, 0xc3),
      mutate(sof + 4, 12),
      mutate(sof + 9, 0),
      mutate(sof + 11, 0),
      mutate(sof + 12, 4),
      mutate(sos + 4, 0),
      mutate(sos + 5, 99),
      mutate(sos + 6, 0x44),
      mutate(sos + 12, 1),
      Buffer.concat([original.subarray(0, 2), Buffer.from([255, 208]), original.subarray(2)]),
      Buffer.concat([
        original.subarray(0, sof),
        original.subarray(sof, sof + 19),
        original.subarray(sof),
      ]),
    ])
      await expect(parse(bytes)).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    const entropy = sos + 2 + original.readUInt16BE(sos + 2);
    await expect(
      parse(
        Buffer.concat([
          original.subarray(0, entropy + 1),
          Buffer.from([255, 0, 255, 208]),
          original.subarray(entropy + 1),
        ]),
      ),
    ).resolves.toMatchObject({ encodedWidth: 30 });
    await expect(
      parse(Buffer.concat([original.subarray(0, entropy + 1), Buffer.from([255, 255, 217])])),
    ).resolves.toMatchObject({ encodedWidth: 30 });
    await expect(
      parse(Buffer.concat([original.subarray(0, entropy + 1), Buffer.from([255, 255])])),
    ).rejects.toThrow();
  });
  it('checks EXIF external value offsets, duplicate IFD tags and finite IFD/entry budgets', async () => {
    const payload = Buffer.from(jpeg().subarray(6, 38));
    const wrap = (p: Buffer) =>
      Buffer.concat([Buffer.from([255, 216]), segment(0xe1, p), jpegWithoutExif().subarray(2)]);
    const duplicate = Buffer.concat([
      payload.subarray(0, 16),
      payload.subarray(16, 28),
      payload.subarray(16, 28),
      Buffer.alloc(4),
    ]);
    duplicate.writeUInt16LE(2, 14);
    await expect(parse(wrap(duplicate))).rejects.toThrow();
    const external = Buffer.concat([payload, Buffer.alloc(8)]);
    external.writeUInt16LE(0x10e, 16);
    external.writeUInt16LE(2, 18);
    external.writeUInt32LE(8, 20);
    external.writeUInt32LE(26, 24);
    await expect(parse(wrap(external))).resolves.toMatchObject({ orientation: 1 });
    for (const offset of [0, 8, 0xffffffff]) {
      const b = Buffer.from(external);
      b.writeUInt32LE(offset, 24);
      await expect(parse(wrap(b))).rejects.toThrow();
    }
    const overEntries = Buffer.from(payload);
    overEntries.writeUInt16LE(257, 14);
    await expect(parse(wrap(overEntries))).rejects.toMatchObject({ code: 'METADATA_LIMIT' });
    for (const count of [8, 9]) {
      const tiff = Buffer.alloc(8 + count * 6);
      tiff.write('II');
      tiff.writeUInt16LE(42, 2);
      tiff.writeUInt32LE(8, 4);
      for (let i = 0; i < count - 1; i++) tiff.writeUInt32LE(8 + (i + 1) * 6, 10 + i * 6);
      const result = parse(wrap(Buffer.concat([Buffer.from('Exif\0\0'), tiff])));
      if (count === 8) await expect(result).resolves.toMatchObject({ orientation: 1 });
      else await expect(result).rejects.toMatchObject({ code: 'METADATA_LIMIT' });
    }
  });
});
