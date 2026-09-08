import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSourceMetadata } from '../../../src/infrastructure/metadata/parseSourceMetadata';
import {
  displayedImagePoint,
  metadataContainsLocator,
  SourceMetadataFactsSchema,
} from '../../../src/shared/contracts/sourceMetadata';
import {
  nestedPdfObjects,
  pdfObjects,
  splitPdf,
  wideDeepPdf,
} from '../../fixtures/metadata/pdfTree';
import { jpeg, pdf, png, pptxParts, wav, zip } from '../../fixtures/metadata/synthetic';

const parse = (bytes: Buffer, extension: string) =>
  parseSourceMetadata({
    bytes,
    extension,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
describe('metadata resource and coordinate boundaries', () => {
  it('counts complete nested PDF trees and accepts the depth boundary', async () => {
    await expect(parse(pdfObjects(nestedPdfObjects), '.pdf')).resolves.toEqual({
      kind: 'pdf',
      pageCount: 4,
    });
    await expect(parse(wideDeepPdf(1, 62), '.pdf')).resolves.toEqual({ kind: 'pdf', pageCount: 1 });
  });
  it('accepts exact node, page and fanout boundaries', async () => {
    await expect(parse(wideDeepPdf(1365, 2), '.pdf')).resolves.toEqual({
      kind: 'pdf',
      pageCount: 1365,
    });
    await expect(parse(pdf(2000), '.pdf')).resolves.toEqual({ kind: 'pdf', pageCount: 2000 });
  });
  it.each([
    [1, '/Count 4', '/Count 1'],
    [1, '/Count 4', '/Count 5'],
    [2, '/Count 2', '/Count 1'],
    [2, '/Count 2', '/Count 3'],
    [2, '/Count 2', '/Count 0'],
    [2, '/Count 2', '/Count 2.5'],
    [2, '/Count 2', '/Count /Wrong'],
    [2, '/Count 2', ''],
    [1, '/Kids [3 0 R 4 0 R]', '/Kids [3 0 R 3 0 R]'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids [2 0 R 6 0 R]'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids [999 0 R 6 0 R]'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids [1 0 R 6 0 R]'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids [null 6 0 R]'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids []'],
    [2, '/Kids [5 0 R 6 0 R]', '/Kids /Wrong'],
    [2, '/Parent 2 0 R', '/Parent 4 0 R'],
    [4, '/Parent 3 0 R', '/Parent 4 0 R'],
    [4, '/Parent 3 0 R', ''],
    [1, '/Type /Pages', '/Type /Pages /Parent 1 0 R'],
    [1, '/Type /Pages', '/Type /Pages /Parent null'],
    [0, '/Pages 2 0 R', '/Pages 999 0 R'],
    [0, '/Pages 2 0 R', '/Pages null'],
    [2, '/Parent 2 0 R', '/Parent 2 1 R'],
    [4, '/Type /Page', '/Type /Page /Kids []'],
    [4, '/Type /Page', '/Type /Page /Count 1'],
    [4, '/Type /Page', '/Type /Unknown'],
  ] as const)('rejects inconsistent PDF graph object %s: %s -> %s', async (index, from, to) => {
    const bytes = pdfObjects(
      nestedPdfObjects.map((object, i) => (i === index ? object.replace(from, to) : object)),
    );
    await expect(parse(bytes, '.pdf')).rejects.toMatchObject({ code: 'METADATA_INVALID' });
  });
  it.each([
    ['depth', () => wideDeepPdf(1, 63)],
    ['nodes', () => wideDeepPdf(1400, 2)],
    [
      'fanout',
      () => Buffer.from(wideDeepPdf(2001, 0).toString().replace('/Count 2001', '/Count 1   ')),
    ],
    ['pages', () => pdf(2001)],
    ['actual leaves despite understated root count', () => splitPdf(2001, 1)],
  ] as const)('enforces the independent PDF %s budget', async (_name, make) => {
    await expect(parse(make(), '.pdf')).rejects.toMatchObject({ code: 'METADATA_LIMIT' });
  });
  it('checks real measured page10 vs page0/11, audio end, ordered slide and normalized lines', async () => {
    const facts = await parse(pdf(), '.pdf');
    expect(metadataContainsLocator(facts, { kind: 'document', page: 10 })).toBe(true);
    for (const page of [0, 11, NaN])
      expect(metadataContainsLocator(facts, { kind: 'document', page })).toBe(false);
    expect(
      metadataContainsLocator(await parse(wav(), '.wav'), {
        kind: 'audio',
        startMs: 0,
        endMs: 1000,
      }),
    ).toBe(true);
    expect(
      metadataContainsLocator(await parse(wav(), '.wav'), {
        kind: 'audio',
        startMs: 0,
        endMs: 1001,
      }),
    ).toBe(false);
    expect(
      metadataContainsLocator(await parse(zip(pptxParts), '.pptx'), { kind: 'slide', slide: 3 }),
    ).toBe(false);
    expect(
      metadataContainsLocator(await parse(Buffer.from('a\nb'), '.txt'), {
        kind: 'text',
        startLine: 1,
        endLine: 3,
      }),
    ).toBe(false);
    const image = await parse(jpeg(6), '.jpg');
    expect(metadataContainsLocator(image, { kind: 'image', x: 0, y: 0, width: 1, height: 1 })).toBe(
      true,
    );
    expect(
      metadataContainsLocator(image, { kind: 'image', x: 0, y: 0, width: 1 + 1 / 20, height: 1 }),
    ).toBe(false);
  });
  it('maps a noncentral encoded point and every frame corner for orientations1–8', () => {
    const expected = [
      [3, 7],
      [27, 7],
      [27, 13],
      [3, 13],
      [7, 3],
      [13, 3],
      [13, 27],
      [7, 27],
    ];
    for (let orientation = 1; orientation <= 8; orientation++) {
      expect(displayedImagePoint(3, 7, 30, 20, orientation)).toEqual(expected[orientation - 1]);
      for (const [x, y] of [
        [0, 0],
        [30, 0],
        [0, 20],
        [30, 20],
      ]) {
        const p = displayedImagePoint(x ?? 0, y ?? 0, 30, 20, orientation);
        expect(p[0]).toBeGreaterThanOrEqual(0);
        expect(p[0]).toBeLessThanOrEqual(orientation >= 5 ? 20 : 30);
        expect(p[1]).toBeLessThanOrEqual(orientation >= 5 ? 30 : 20);
      }
    }
    for (const [x, y, o] of [
      [-1, 0, 1],
      [31, 0, 1],
      [0, 21, 1],
      [NaN, 0, 1],
      [Infinity, 0, 1],
      [0, 0, 9],
      [0, 0, 1.5],
    ])
      expect(() => displayedImagePoint(x ?? 0, y ?? 0, 30, 20, o ?? 1)).toThrow();
  });
  it('rejects invalid image envelopes/dimensions/orientation and invalid decoded text', async () => {
    for (const [b, ext] of [
      [jpeg(9), '.jpg'],
      [jpeg().subarray(0, -1), '.jpg'],
      [png.subarray(0, -1), '.png'],
      [Buffer.from([0xc0, 0xaf]), '.txt'],
      [Buffer.from('\0private'), '.md'],
      [Buffer.from('\n'.repeat(1_000_000)), '.txt'],
    ] as const)
      await expect(parse(b, ext)).rejects.toThrow();
    expect(
      SourceMetadataFactsSchema.safeParse({
        kind: 'audio',
        durationSeconds: Infinity,
        assurance: 'structural',
      }).success,
    ).toBe(false);
    expect(
      SourceMetadataFactsSchema.safeParse({
        kind: 'audio',
        durationSeconds: 86401,
        assurance: 'structural',
      }).success,
    ).toBe(false);
  });
  it('rejects RIFF truncation, forged byte rate, alignment and unsupported encoding', async () => {
    for (const [offset, value] of [
      [4, 3],
      [28, 1],
      [32, 1],
      [20, 3],
    ] as const) {
      const b = wav();
      b.writeUInt32LE(value, offset);
      await expect(parse(b, '.wav')).rejects.toThrow();
    }
    await expect(parse(wav().subarray(0, -1), '.wav')).rejects.toThrow();
  });
  it('rejects malformed/broken/truncated PDF trees without source diagnostics', async () => {
    for (const b of [
      pdf().subarray(0, -30),
      Buffer.from('%PDF-1.7\nprivate\n%%EOF'),
      Buffer.from(pdf().toString().replace('/Kids [3 0 R', '/Kids [999 0 R')),
    ])
      await expect(parse(b, '.pdf')).rejects.toThrow(/^METADATA_/);
  });
  it('rejects external required relationships, duplicate slide IDs, bomb declarations and XML expansion', async () => {
    const transformed = (name: string, fn: (s: string) => string) =>
      zip(pptxParts.map(([n, v]) => [n, n === name ? fn(v) : v] as const));
    for (const b of [
      transformed('_rels/.rels', (s) => s.replace('Target="', 'TargetMode="External" Target="')),
      transformed('ppt/presentation.xml', (s) => s.replace('id="257"', 'id="256"')),
      transformed(
        'ppt/presentation.xml',
        (s) => `<!DOCTYPE a [<!ENTITY x SYSTEM "https://invalid.test/secret">]>${s}`,
      ),
      transformed('ppt/presentation.xml', (s) => s + ' '.repeat(2_097_152)),
    ])
      await expect(parse(b, '.pptx')).rejects.toThrow();
    const bomb = zip(pptxParts);
    const central = bomb.indexOf(Buffer.from('504b0102', 'hex'));
    bomb.writeUInt32LE(64_000_001, central + 24);
    await expect(parse(bomb, '.pptx')).rejects.toThrow();
  });
});
