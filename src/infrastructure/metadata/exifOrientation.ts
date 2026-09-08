import type { Buffer } from 'node:buffer';
import { METADATA_LIMITS } from '../../shared/contracts/sourceMetadata';
import { invalid, limit } from './metadataError';

/** Bounded classic TIFF IFD graph; orientation is accepted only in the primary IFD. */
export const exifOrientation = (tiff: Buffer): number => {
  if (tiff.length < 8) return invalid();
  const endian = tiff.toString('latin1', 0, 2);
  if (endian !== 'II' && endian !== 'MM') return invalid();
  const u16 = (at: number) => (endian === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (endian === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return invalid();
  const primary = u32(4);
  const pending = [primary];
  const visited = new Set<number>();
  let entries = 0;
  let orientation: number | undefined;
  while (pending.length) {
    const offset = pending.pop() as number;
    if (visited.has(offset) || offset < 8 || offset + 2 > tiff.length) return invalid();
    if (visited.size >= METADATA_LIMITS.imageIfds) return limit();
    visited.add(offset);
    const count = u16(offset);
    entries += count;
    if (entries > METADATA_LIMITS.imageIfdEntries) return limit();
    const end = offset + 2 + count * 12;
    if (end + 4 > tiff.length) return invalid();
    const tags = new Set<number>();
    for (let at = offset + 2; at < end; at += 12) {
      const tag = u16(at);
      const type = u16(at + 2);
      const length = u32(at + 4);
      if (tags.has(tag)) return invalid();
      tags.add(tag);
      const width = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type];
      if (!width || length < 1) return invalid();
      const size = width * length;
      if (size > 4) {
        const start = u32(at + 8);
        if (start < 8 || start + size > tiff.length || (start < end + 4 && start + size > offset))
          return invalid();
      }
      if (tag === 0x112) {
        if (offset !== primary || orientation !== undefined || type !== 3 || length !== 1)
          return invalid();
        orientation = u16(at + 8);
        if (orientation < 1 || orientation > 8) return invalid();
      }
      if ([0x8769, 0x8825, 0xa005].includes(tag)) {
        if (type !== 4 || length !== 1) return invalid();
        pending.push(u32(at + 8));
      }
    }
    const next = u32(end);
    if (next) pending.push(next);
  }
  return orientation ?? 1;
};
