import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSourceMetadata } from '../../../src/infrastructure/metadata/parseSourceMetadata';
import { SourceMetadataFactsSchema } from '../../../src/shared/contracts/sourceMetadata';
import hashes from '../../fixtures/metadata/hashes.json';
import { box, jpeg, m4a, pdf, png, pptxParts, wav, zip } from '../../fixtures/metadata/synthetic';

const parse = (bytes: Buffer, extension: string) =>
  parseSourceMetadata({
    bytes,
    extension,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
describe('trusted local source metadata', () => {
  it('preserves fixture bytes and independently pinned identities after actual parsing', async () => {
    const cases = [
      ['wav', wav(), '.wav'],
      ['m4a', m4a(), '.m4a'],
      ['pdf1', pdf(1), '.pdf'],
      ['pdf10', pdf(), '.pdf'],
      ['png', png, '.png'],
      ['pptx', zip(pptxParts), '.pptx'],
      ...Array.from({ length: 8 }, (_, i) => [`jpeg${i + 1}`, jpeg(i + 1), '.jpeg'] as const),
    ] as const;
    for (const [name, bytes, extension] of cases) {
      const expected = hashes[name as keyof typeof hashes];
      expect(bytes.length).toBe(expected.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
      await parse(bytes, extension);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
    }
  });
  it('measures PCM and ordinary single-track M4A structural duration', async () => {
    expect(await parse(wav(), '.wav')).toEqual({
      kind: 'audio',
      durationSeconds: 1,
      assurance: 'structural',
    });
    expect(await parse(m4a(), '.m4a')).toEqual({
      kind: 'audio',
      durationSeconds: 1,
      assurance: 'structural',
    });
  });
  it('resolves a real ten-page PDF tree and single page', async () => {
    expect(await parse(pdf(), '.pdf')).toEqual({ kind: 'pdf', pageCount: 10 });
    expect(await parse(pdf(1), '.pdf')).toEqual({ kind: 'pdf', pageCount: 1 });
  });
  it('scans complete MPEG-1 Layer III CBR/VBR frames without trusting Xing tags', async () => {
    const frame = (bitrateIndex: number, bytes: number) => {
      const b = Buffer.alloc(bytes);
      b.writeUInt32BE((0xfffb0000 | (bitrateIndex << 12)) >>> 0);
      return b;
    };
    for (const b of [
      Buffer.concat([frame(9, 417), frame(9, 417)]),
      Buffer.concat([frame(9, 417), frame(10, 522)]),
    ]) {
      expect(await parse(b, '.mp3')).toMatchObject({ durationSeconds: 2304 / 44100 });
      await expect(parse(b.subarray(0, -1), '.mp3')).rejects.toThrow();
    }
  });
  it('retains relationship presentation order, counting hidden slides and ignoring orphans/app.xml', async () => {
    expect(await parse(zip(pptxParts), '.pptx')).toEqual({
      kind: 'presentation',
      slideParts: ['ppt/slides/slide9.xml', 'ppt/slides/slide2.xml'],
    });
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'defines encoded and displayed frames for EXIF %i',
    async (orientation) => {
      expect(await parse(jpeg(orientation), '.jpg')).toEqual({
        kind: 'image',
        encodedWidth: 30,
        encodedHeight: 20,
        displayWidth: orientation >= 5 ? 20 : 30,
        displayHeight: orientation >= 5 ? 30 : 20,
        orientation,
        coordinateFrame: 'display-pixel-edges',
      });
    },
  );
  it('parses PNG and normalizes UTF-8 BOM/newlines without changing words', async () => {
    expect(await parse(png, '.png')).toMatchObject({ displayWidth: 1, displayHeight: 1 });
    expect(await parse(Buffer.from('\ufeff한글\r\nx\ry\n'), '.md')).toEqual({
      kind: 'text',
      lineCount: 3,
      normalizedCodeUnits: 7,
      normalization: 'utf8-bom-crlf-v1',
    });
  });
  it('verifies hash and size before any format parser', async () => {
    await expect(
      parseSourceMetadata({
        bytes: pdf(),
        extension: '.pdf',
        sha256: '0'.repeat(64),
        sizeBytes: pdf().length,
      }),
    ).rejects.toThrow('METADATA_IDENTITY');
  });
  it.each(['.mp4', '.heic', '.aac', '.flac'])(
    'explicitly rejects unproved %s bounds',
    async (extension) => {
      await expect(parse(m4a(), extension)).rejects.toThrow('METADATA_UNSUPPORTED');
    },
  );
  it('rejects M4A edit lists, fragments, extra tracks and truncation', async () => {
    for (const b of [
      m4a(box('edts', box('elst', Buffer.alloc(8)))),
      Buffer.concat([m4a(), box('moof')]),
      m4a(box('trak')),
      m4a().subarray(0, -1),
    ])
      await expect(parse(b, '.m4a')).rejects.toThrow();
  });
  it('rejects conflicting movie/track durations and non-audio sample descriptions', async () => {
    for (const name of ['mvhd', 'tkhd']) {
      const b = m4a();
      const p = b.indexOf(name) + 4;
      b.writeUInt32BE(16000, p + (name === 'mvhd' ? 16 : 20));
      await expect(parse(b, '.m4a')).rejects.toThrow();
    }
    const b = m4a();
    b.write('avc1', b.indexOf('mp4a'));
    await expect(parse(b, '.m4a')).rejects.toThrow();
  });
  it('rejects unsafe/duplicate ZIP entries, missing slide and custom entities', async () => {
    for (const parts of [
      [...pptxParts, ['../escape', 'x'] as const],
      [...pptxParts, pptxParts[0]],
      pptxParts.filter(([n]) => n !== 'ppt/slides/slide9.xml'),
      pptxParts.map(
        ([n, v]) =>
          [
            n,
            n === 'ppt/presentation.xml' ? `<!DOCTYPE p [<!ENTITY x "secret">]>${v}` : v,
          ] as const,
      ),
    ])
      await expect(parse(zip(parts), '.pptx')).rejects.toThrow();
  });
  it('rejects malformed formats, bounds and unexpected facts', async () => {
    for (const extension of ['.pdf', '.wav', '.m4a', '.png', '.jpg', '.pptx'])
      await expect(parse(Buffer.from('private source text'), extension)).rejects.toThrow();
    expect(SourceMetadataFactsSchema.safeParse({ kind: 'pdf', pageCount: 0 }).success).toBe(false);
    expect(SourceMetadataFactsSchema.safeParse({ kind: 'pdf', pageCount: 2001 }).success).toBe(
      false,
    );
    expect(
      SourceMetadataFactsSchema.safeParse({ kind: 'pdf', pageCount: 10, text: 'private' }).success,
    ).toBe(false);
  });
});
