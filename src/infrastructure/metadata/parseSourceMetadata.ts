import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import type { MetadataByteInput } from '../../core/ports/sourceMetadata';
import { normalizeUtf8Source } from '../../core/text/normalizeUtf8Source';
import {
  METADATA_LIMITS,
  type SourceMetadataFacts,
  SourceMetadataFactsSchema,
} from '../../shared/contracts/sourceMetadata';
import { m4aDuration, mp3Duration, wavDuration } from './audioStructure';
import { imageMetadata } from './imageMetadata';
import { invalid, MetadataError } from './metadataError';
import { countPdfPageTree } from './pdfPageTree';
import { presentationMetadata } from './presentationMetadata';

export const verifyMetadataBytes = (input: MetadataByteInput): Buffer => {
  if (
    !(input.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > METADATA_LIMITS.sourceBytes ||
    input.bytes.byteLength !== input.sizeBytes
  )
    throw new MetadataError('METADATA_LIMIT');
  const bytes = Buffer.from(input.bytes);
  if (
    bytes.length !== input.sizeBytes ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    createHash('sha256').update(bytes).digest('hex') !== input.sha256
  )
    throw new MetadataError('METADATA_IDENTITY');
  return bytes;
};
class RejectingBinaryDataFactory {
  async fetch(): Promise<never> {
    return invalid();
  }
}
const pdfCount = async (bytes: Buffer): Promise<number> => {
  if (
    bytes.toString('ascii', 0, 5) !== '%PDF-' ||
    !bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
  )
    return invalid();
  const pageCount = await countPdfPageTree(bytes);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: Uint8Array.from(bytes),
    stopAtErrors: true,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    BinaryDataFactory: RejectingBinaryDataFactory,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (
      !Number.isSafeInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > METADATA_LIMITS.pages
    )
      throw new MetadataError('METADATA_LIMIT');
    if (document.numPages !== pageCount) return invalid();
    for (let i = 1; i <= pageCount; i++) {
      const page = await document.getPage(i);
      page.cleanup();
    }
    return pageCount;
  } finally {
    await task.destroy();
  }
};
const facts = async (bytes: Buffer, extension: string): Promise<unknown> => {
  switch (extension) {
    case '.wav':
      return { kind: 'audio', durationSeconds: wavDuration(bytes), assurance: 'structural' };
    case '.mp3':
      return { kind: 'audio', durationSeconds: mp3Duration(bytes), assurance: 'structural' };
    case '.m4a': {
      const measured = m4aDuration(bytes);
      const result = await parseBuffer(
        bytes,
        { mimeType: 'audio/m4a', size: bytes.length },
        { duration: true, skipCovers: true, includeChapters: false },
      );
      if (
        result.quality.warnings.length ||
        result.format.duration === undefined ||
        Math.abs(result.format.duration - measured) > 1e-6
      )
        return invalid();
      return { kind: 'audio', durationSeconds: measured, assurance: 'structural' };
    }
    case '.pdf':
      return { kind: 'pdf', pageCount: await pdfCount(bytes) };
    case '.pptx':
      return { kind: 'presentation', slideParts: await presentationMetadata(bytes) };
    case '.jpg':
    case '.jpeg':
    case '.png':
      return imageMetadata(bytes, extension);
    case '.txt':
    case '.md': {
      if (bytes.length > 8_000_000) throw new MetadataError('METADATA_LIMIT');
      const text = normalizeUtf8Source(bytes);
      if (text.includes('\0')) return invalid();
      let lineCount = 1;
      for (const character of text)
        if (character === '\n' && ++lineCount > 1_000_000)
          throw new MetadataError('METADATA_LIMIT');
      return {
        kind: 'text',
        lineCount,
        normalizedCodeUnits: text.length,
        normalization: 'utf8-bom-crlf-v1',
      };
    }
    default:
      throw new MetadataError('METADATA_UNSUPPORTED');
  }
};
/** Internal byte parser. Production callers must use the externally terminable worker port. */
export const parseSourceMetadata = async (
  input: MetadataByteInput,
): Promise<SourceMetadataFacts> => {
  try {
    const bytes = verifyMetadataBytes(input);
    return SourceMetadataFactsSchema.parse(await facts(bytes, input.extension));
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    throw new MetadataError('METADATA_INVALID');
  }
};
