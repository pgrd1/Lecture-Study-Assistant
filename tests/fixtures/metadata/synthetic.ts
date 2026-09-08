// Original synthetic fixtures: deterministic, no lectures, downloads or licensed source material.
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

export const wav = (): Buffer => {
  const b = Buffer.alloc(44 + 16000);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(16000, 40);
  return b;
};
export const box = (name: string, ...data: Buffer[]): Buffer => {
  const body = Buffer.concat(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(name, 4);
  return Buffer.concat([header, body]);
};
export const m4a = (extra: Buffer = Buffer.alloc(0)): Buffer => {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(8000, 12);
  mdhd.writeUInt32BE(8000, 16);
  const hdlr = Buffer.alloc(24);
  hdlr.write('soun', 8);
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(8, 8);
  stts.writeUInt32BE(1000, 12);
  const sample = Buffer.alloc(28);
  sample.writeUInt16BE(1, 6);
  sample.writeUInt16BE(1, 16);
  sample.writeUInt16BE(16, 18);
  sample.writeUInt32BE(8000 * 65536, 24);
  const stsd = Buffer.alloc(8);
  stsd.writeUInt32BE(1, 4);
  const stsz = Buffer.alloc(12);
  stsz.writeUInt32BE(2, 4);
  stsz.writeUInt32BE(8, 8);
  const stsc = Buffer.alloc(20);
  stsc.writeUInt32BE(1, 4);
  stsc.writeUInt32BE(1, 8);
  stsc.writeUInt32BE(8, 12);
  stsc.writeUInt32BE(1, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(3, 0);
  tkhd.writeUInt32BE(1, 12);
  tkhd.writeUInt32BE(8000, 20);
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(8000, 12);
  mvhd.writeUInt32BE(8000, 16);
  const makeMoov = (offset: number) => {
    const stco = Buffer.alloc(12);
    stco.writeUInt32BE(1, 4);
    stco.writeUInt32BE(offset, 8);
    return box(
      'moov',
      box('mvhd', mvhd),
      box(
        'trak',
        box('tkhd', tkhd),
        extra,
        box(
          'mdia',
          box('mdhd', mdhd),
          box('hdlr', hdlr),
          box(
            'minf',
            box(
              'stbl',
              box('stsd', stsd, box('mp4a', sample)),
              box('stts', stts),
              box('stsz', stsz),
              box('stsc', stsc),
              box('stco', stco),
            ),
          ),
        ),
      ),
    );
  };
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'binary'));
  const moov = makeMoov(ftyp.length + makeMoov(0).length + 8);
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(16))]);
};
export const pdf = (pages = 10, compressed = false): Buffer => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from(
      { length: pages },
      () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Rotate 90 /Resources << >> >>',
    ),
  ];
  if (compressed)
    objects.push(
      `<< /Length 8 /Filter /FlateDecode >>\nstream\n${deflateSync(Buffer.alloc(0)).toString('binary')}\nendstream`,
    );
  let content = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content, 'binary'));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content, 'binary');
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content, 'binary');
};
export const jpeg = (orientation = 1): Buffer => {
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0', 'binary');
  exif.write('II', 6);
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14);
  exif.writeUInt16LE(0x112, 16);
  exif.writeUInt16LE(3, 18);
  exif.writeUInt32LE(1, 20);
  exif.writeUInt16LE(orientation, 24);
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1);
  segment.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment,
    exif,
    // Original 30x20 solid RGB(102,153,204) raster encoded by @napi-rs/canvas1.0.8.
    // APP0/ICC omitted; SOI comes from above. This retains real quantization/Huffman/scan data.
    Buffer.from(
      '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAUAB4DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCrAVtLwAAAAAH/2Q=='.replaceAll(
        ' ',
        '',
      ),
      'base64',
    ).subarray(2),
  ]);
};
export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=',
  'base64',
);

// Store-only ZIP with CRC32; accepts duplicates/hostile names for rejection fixtures.
const crc32 = (b: Buffer): number => {
  let crc = -1;
  for (const v of b) {
    crc ^= v;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
};
export const zip = (entries: readonly (readonly [string, string])[]): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const n = Buffer.from(name);
    const b = Buffer.from(content);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt32LE(crc32(b), 14);
    l.writeUInt32LE(b.length, 18);
    l.writeUInt32LE(b.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc32(b), 16);
    c.writeUInt32LE(b.length, 20);
    c.writeUInt32LE(b.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(l, n, b);
    central.push(c, n);
    offset += l.length + n.length + b.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};
export const pptxParts = [
  [
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide9.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  ],
  [
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  ],
  [
    'ppt/presentation.xml',
    '<q:presentation xmlns:q="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><q:sldIdLst><q:sldId id="256" r:id="r9"/><q:sldId id="257" r:id="r2"/></q:sldIdLst></q:presentation>',
  ],
  [
    'ppt/_rels/presentation.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide9.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
  ],
  [
    'ppt/slides/slide9.xml',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" show="0"/>',
  ],
  [
    'ppt/slides/slide2.xml',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  ],
  ['ppt/slides/orphan.xml', '<orphan/>'],
  ['docProps/app.xml', '<Slides>999</Slides>'],
] as const;
