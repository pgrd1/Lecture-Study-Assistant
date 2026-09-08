import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { type Entry, fromBuffer, type ZipFile } from 'yauzl';
import { METADATA_LIMITS as limits } from '../../shared/contracts/sourceMetadata';
import { invalid, limit, MetadataError } from './metadataError';
import { SaxesParser, type SaxesTagNS } from './saxesAdapter';

const NS = 'http://schemas.openxmlformats.org/';
const P = `${NS}presentationml/2006/main`;
const R = `${NS}officeDocument/2006/relationships`;
const PKG = `${NS}package/2006/relationships`;
const CT = `${NS}package/2006/content-types`;
const safeName = (name: string): boolean =>
  name.length <= 100 &&
  !/[\\\p{Cc}\s:%?#]/u.test(name) &&
  !name.startsWith('/') &&
  !name.split('/').some((p) => p === '.' || p === '..' || p === '');
const xml = (bytes: Buffer, visit: (tag: SaxesTagNS, path: readonly string[]) => void): void => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<\?xml[^?]*encoding\s*=\s*["'](?!utf-8["'])/iu.test(text))
    throw new MetadataError('METADATA_UNSUPPORTED');
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let nodes = 0;
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', (tag) => {
    if (++nodes > limits.xmlNodes || path.length >= limits.xmlDepth) return limit();
    path.push(`{${tag.uri}}${tag.local}`);
    if (tag.local === 'AlternateContent') throw new MetadataError('METADATA_UNSUPPORTED');
    visit(tag, path);
  });
  parser.on('closetag', () => {
    path.pop();
  });
  parser.write(text).close();
};
const attr = (tag: SaxesTagNS, name: string, uri = ''): string => {
  const values = Object.values(tag.attributes).filter((a) => a.local === name && a.uri === uri);
  if (values.length !== 1) return invalid();
  return values[0]?.value ?? invalid();
};
type Relationship = Readonly<{ id: string; type: string; target: string; external: boolean }>;
const relationships = (bytes: Buffer): readonly Relationship[] => {
  const result: Relationship[] = [];
  const ids = new Set<string>();
  xml(bytes, (tag, path) => {
    if (path.length === 1 && (tag.uri !== PKG || tag.local !== 'Relationships')) return invalid();
    if (tag.uri !== PKG || tag.local !== 'Relationship') return;
    if (path.length !== 2) return invalid();
    const id = attr(tag, 'Id');
    if (ids.has(id)) return invalid();
    ids.add(id);
    const mode = tag.attributes.TargetMode?.value;
    if (mode !== undefined && mode !== 'External' && mode !== 'Internal') return invalid();
    result.push({
      id,
      type: attr(tag, 'Type'),
      target: attr(tag, 'Target'),
      external: mode === 'External',
    });
  });
  return result;
};
const requiredTarget = (base: string, rel: Relationship): string => {
  if (rel.external) throw new MetadataError('METADATA_UNSUPPORTED');
  if (!safeName(rel.target)) return invalid();
  const result = posix.join(posix.dirname(base), rel.target);
  if (!safeName(result)) return invalid();
  return result;
};

export const presentationMetadata = async (bytes: Buffer): Promise<readonly string[]> => {
  const archive = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      bytes,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) =>
        error || !zip ? reject(new MetadataError('METADATA_INVALID')) : resolve(zip),
    ),
  );
  try {
    const entries = await new Promise<ReadonlyMap<string, Entry>>((resolve, reject) => {
      const found = new Map<string, Entry>();
      let expanded = 0;
      archive.on('error', () => reject(new MetadataError('METADATA_INVALID')));
      archive.on('entry', (entry: Entry) => {
        try {
          const name = entry.fileName.endsWith('/') ? entry.fileName.slice(0, -1) : entry.fileName;
          if (
            !safeName(name) ||
            found.has(entry.fileName) ||
            entry.generalPurposeBitFlag & 1 ||
            ![0, 8].includes(entry.compressionMethod)
          )
            return invalid();
          if (found.size >= limits.zipEntries) return limit();
          expanded += entry.uncompressedSize;
          if (
            expanded > 256_000_000 ||
            entry.uncompressedSize > 64_000_000 ||
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100
          )
            return limit();
          found.set(entry.fileName, entry);
          archive.readEntry();
        } catch {
          reject(new MetadataError('METADATA_INVALID'));
          archive.close();
        }
      });
      archive.on('end', () => resolve(found));
      archive.readEntry();
    });
    let total = 0;
    const read = async (name: string): Promise<Buffer> => {
      const entry = entries.get(name);
      if (!entry) return invalid();
      if (
        entry.uncompressedSize > limits.xmlBytes ||
        total + entry.uncompressedSize > limits.totalXmlBytes
      )
        return limit();
      total += entry.uncompressedSize;
      return new Promise<Buffer>((resolve, reject) =>
        archive.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(new MetadataError('METADATA_INVALID'));
          let length = 0;
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > entry.uncompressedSize || length > limits.xmlBytes) {
              stream.destroy();
              reject(new MetadataError('METADATA_LIMIT'));
            } else chunks.push(chunk);
          });
          stream.on('error', () => reject(new MetadataError('METADATA_INVALID')));
          stream.on('end', () =>
            length === entry.uncompressedSize
              ? resolve(Buffer.concat(chunks))
              : reject(new MetadataError('METADATA_INVALID')),
          );
        }),
      );
    };
    const types = new Map<string, string>();
    xml(await read('[Content_Types].xml'), (tag, path) => {
      if (path.length === 1 && (tag.uri !== CT || tag.local !== 'Types')) return invalid();
      if (tag.uri === CT && tag.local === 'Override') {
        const name = attr(tag, 'PartName');
        if (!name.startsWith('/') || !safeName(name.slice(1)) || types.has(name.slice(1)))
          return invalid();
        types.set(name.slice(1), attr(tag, 'ContentType'));
      }
    });
    const office = relationships(await read('_rels/.rels')).filter(
      (r) => r.type === `${R}/officeDocument`,
    );
    if (office.length !== 1) return invalid();
    const main = requiredTarget('', office[0] as Relationship);
    if (
      types.get(main) !==
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
    )
      return invalid();
    const ids: string[] = [];
    const slideIds = new Set<string>();
    xml(await read(main), (tag, path) => {
      if (path.length === 1 && (tag.uri !== P || tag.local !== 'presentation'))
        throw new MetadataError('METADATA_UNSUPPORTED');
      if (tag.uri === P && tag.local === 'sldId') {
        if (path.join('/') !== `{${P}}presentation/{${P}}sldIdLst/{${P}}sldId`) return invalid();
        const id = attr(tag, 'id');
        if (slideIds.has(id) || ids.length >= limits.pages) return invalid();
        slideIds.add(id);
        ids.push(attr(tag, 'id', R));
      }
    });
    if (!ids.length || new Set(ids).size !== ids.length) return invalid();
    const rels = relationships(
      await read(posix.join(posix.dirname(main), '_rels', `${posix.basename(main)}.rels`)),
    );
    const parts: string[] = [];
    for (const id of ids) {
      const rel = rels.find((r) => r.id === id);
      if (!rel || rel.type !== `${R}/slide`) return invalid();
      const part = requiredTarget(main, rel);
      if (
        parts.includes(part) ||
        types.get(part) !== 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
      )
        return invalid();
      xml(await read(part), (tag, path) => {
        if (path.length === 1 && (tag.uri !== P || tag.local !== 'sld')) return invalid();
      });
      parts.push(part);
    }
    return Object.freeze(parts);
  } finally {
    archive.close();
  }
};
