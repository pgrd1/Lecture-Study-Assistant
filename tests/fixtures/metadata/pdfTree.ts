import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

/** Real indirect objects, xref offsets and trailer; no parser library generates these fixtures. */
export const pdfObjects = (objects: readonly string[]): Buffer => {
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
};
export const nestedPdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 4 /Kids [3 0 R 4 0 R] >>',
  '<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [5 0 R 6 0 R] >>',
  '<< /Type /Pages /Parent 2 0 R /Count 2 /Kids [7 0 R 8 0 R] >>',
  ...[3, 3, 4, 4].map(
    (parent) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 300 200] /Resources <<>> >>`,
  ),
] as const;

/** Root + width independent chains of branchCount Pages nodes, each ending in one Page. */
export const wideDeepPdf = (width: number, branchCount: number): Buffer => {
  const children = Array.from({ length: width }, (_, i) => 3 + i * (branchCount + 1));
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${width} /Kids [${children.map((n) => `${n} 0 R`).join(' ')}] >>`,
    ...children.flatMap((first) => [
      ...Array.from(
        { length: branchCount },
        (_, i) =>
          `<< /Type /Pages /Parent ${i === 0 ? 2 : first + i - 1} 0 R /Count 1 /Kids [${first + i + 1} 0 R] >>`,
      ),
      `<< /Type /Page /Parent ${branchCount === 0 ? 2 : first + branchCount - 1} 0 R /MediaBox [0 0 300 200] /Resources <<>> >>`,
    ]),
  ]);
};

/** Keeps fanout/nodes below policy while independently exercising the actual leaf budget. */
export const splitPdf = (pages: number, declared = pages): Buffer => {
  const halfway = Math.floor(pages / 2);
  const kids = (start: number, length: number) =>
    Array.from({ length }, (_, i) => `${start + i} 0 R`).join(' ');
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${declared} /Kids [3 0 R 4 0 R] >>`,
    `<< /Type /Pages /Parent 2 0 R /Count ${halfway} /Kids [${kids(5, halfway)}] >>`,
    `<< /Type /Pages /Parent 2 0 R /Count ${pages - halfway} /Kids [${kids(5 + halfway, pages - halfway)}] >>`,
    ...Array.from(
      { length: pages },
      (_, i) =>
        `<< /Type /Page /Parent ${i < halfway ? 3 : 4} 0 R /MediaBox [0 0 300 200] /Resources <<>> >>`,
    ),
  ]);
};

/** PDF1.7 Flate-compressed ObjStm + genuine type2 xref-stream entries; bounded padding. */
export const compressedPdf = (padding = 0, declared = 1): Buffer => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${declared} /Kids [3 0 R] >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources <<>> >>',
  ] as const;
  const header = `1 0 2 ${objects[0].length + 1} 3 ${objects[0].length + objects[1].length + 2} `;
  const compressed = deflateSync(
    Buffer.concat([Buffer.from(header + objects.join(' ')), Buffer.alloc(padding, 32)]),
  );
  const prefix = Buffer.from('%PDF-1.7\n');
  const obj = Buffer.concat([
    Buffer.from(
      `4 0 obj\n<< /Type /ObjStm /N 3 /First ${header.length} /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
    ),
    compressed,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
  const xref = Buffer.alloc(6 * 7);
  xref.writeUInt16BE(65535, 5);
  for (let i = 1; i <= 3; i++) {
    xref[i * 7] = 2;
    xref.writeUInt32BE(4, i * 7 + 1);
    xref.writeUInt16BE(i - 1, i * 7 + 5);
  }
  for (const [id, offset] of [
    [4, prefix.length],
    [5, prefix.length + obj.length],
  ] as const) {
    xref[id * 7] = 1;
    xref.writeUInt32BE(offset, id * 7 + 1);
  }
  const packedXref = deflateSync(xref);
  return Buffer.concat([
    prefix,
    obj,
    Buffer.from(
      `5 0 obj\n<< /Type /XRef /Size 6 /Root 1 0 R /W [1 4 2] /Length ${packedXref.length} /Filter /FlateDecode >>\nstream\n`,
    ),
    packedXref,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${prefix.length + obj.length}\n%%EOF\n`),
  ]);
};
