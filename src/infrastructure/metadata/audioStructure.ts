import type { Buffer } from 'node:buffer';
import { METADATA_LIMITS } from '../../shared/contracts/sourceMetadata';
import { invalid, limit, MetadataError } from './metadataError';

type Box = Readonly<{
  name: string;
  start: number;
  end: number;
  data: number;
  children: readonly Box[];
}>;
const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex']);
const one = (boxes: readonly Box[], name: string): Box => {
  const matches = boxes.filter((b) => b.name === name);
  if (matches.length !== 1) return invalid();
  return matches[0] as Box;
};
export const m4aDuration = (bytes: Buffer): number => {
  let nodes = 0;
  let tracks = 0;
  const read = (start: number, end: number, depth: number): readonly Box[] => {
    if (depth > 16) return limit();
    const result: Box[] = [];
    for (let offset = start; offset < end; ) {
      if (++nodes > METADATA_LIMITS.audioNodes) return limit();
      if (offset + 8 > end) return invalid();
      const size = bytes.readUInt32BE(offset);
      const name = bytes.toString('ascii', offset + 4, offset + 8);
      if (size < 8 || offset + size > end) return invalid();
      if (name === 'trak' && (++tracks !== 1 || depth !== 1)) return invalid();
      if (['moof', 'mvex', 'edts', 'elst', 'sidx', 'ctts', 'cslg'].includes(name))
        throw new MetadataError('METADATA_UNSUPPORTED');
      result.push({
        name,
        start: offset,
        end: offset + size,
        data: offset + 8,
        children: containers.has(name) ? read(offset + 8, offset + size, depth + 1) : [],
      });
      offset += size;
    }
    return result;
  };
  const root = read(0, bytes.length, 0);
  const ftyp = one(root, 'ftyp');
  if (
    ftyp.end - ftyp.data < 8 ||
    !['M4A ', 'isom', 'mp42'].includes(bytes.toString('ascii', ftyp.data, ftyp.data + 4))
  )
    return invalid();
  const moov = one(root, 'moov');
  const track = one(moov.children, 'trak');
  const media = one(track.children, 'mdia');
  const header = one(media.children, 'mdhd');
  const handler = one(media.children, 'hdlr');
  if (
    header.end - header.data !== 24 ||
    bytes[header.data] !== 0 ||
    handler.end - handler.data < 12 ||
    bytes.toString('ascii', handler.data + 8, handler.data + 12) !== 'soun'
  )
    throw new MetadataError('METADATA_UNSUPPORTED');
  const timescale = bytes.readUInt32BE(header.data + 12);
  const ticks = bytes.readUInt32BE(header.data + 16);
  if (!timescale || !ticks) return invalid();
  const movie = one(moov.children, 'mvhd');
  const trackHeader = one(track.children, 'tkhd');
  if (
    movie.end - movie.data !== 100 ||
    trackHeader.end - trackHeader.data !== 84 ||
    bytes[movie.data] !== 0 ||
    bytes[trackHeader.data] !== 0
  )
    throw new MetadataError('METADATA_UNSUPPORTED');
  const movieScale = bytes.readUInt32BE(movie.data + 12);
  const movieTicks = bytes.readUInt32BE(movie.data + 16);
  const trackTicks = bytes.readUInt32BE(trackHeader.data + 20);
  if (
    !movieScale ||
    !movieTicks ||
    trackTicks !== movieTicks ||
    Math.abs(movieTicks / movieScale - ticks / timescale) > 1 / movieScale ||
    (bytes.readUInt32BE(trackHeader.data) & 3) !== 3
  )
    throw new MetadataError('METADATA_UNSUPPORTED');
  const stbl = one(one(media.children, 'minf').children, 'stbl');
  const description = one(stbl.children, 'stsd');
  const entryOffset = description.data + 8;
  if (
    description.end - description.data < 44 ||
    bytes.readUInt32BE(description.data + 4) !== 1 ||
    bytes.readUInt32BE(entryOffset) !== description.end - entryOffset ||
    bytes.toString('ascii', entryOffset + 4, entryOffset + 8) !== 'mp4a' ||
    bytes.readUInt16BE(entryOffset + 14) !== 1 ||
    bytes.readUInt16BE(entryOffset + 16) !== 0
  )
    throw new MetadataError('METADATA_UNSUPPORTED');
  const stts = one(stbl.children, 'stts');
  if (stts.end - stts.data < 8) return invalid();
  const count = bytes.readUInt32BE(stts.data + 4);
  if (count > METADATA_LIMITS.audioNodes) return limit();
  if (stts.end - stts.data !== 8 + count * 8) return invalid();
  let measured = 0;
  let samples = 0;
  for (let i = 0; i < count; i++) {
    const n = bytes.readUInt32BE(stts.data + 8 + i * 8);
    const duration = bytes.readUInt32BE(stts.data + 12 + i * 8);
    if (!n || !duration) return invalid();
    measured += n * duration;
    samples += n;
  }
  if (
    !Number.isSafeInteger(measured) ||
    measured !== ticks ||
    samples > METADATA_LIMITS.audioSamples
  )
    return invalid();
  const sizes = one(stbl.children, 'stsz');
  if (sizes.end - sizes.data < 12) return invalid();
  const uniform = bytes.readUInt32BE(sizes.data + 4);
  if (
    bytes.readUInt32BE(sizes.data + 8) !== samples ||
    sizes.end - sizes.data !== 12 + (uniform ? 0 : samples * 4)
  )
    return invalid();
  const sampleSize = (index: number) => uniform || bytes.readUInt32BE(sizes.data + 12 + index * 4);
  const offsets = one(stbl.children, 'stco');
  const chunks = bytes.readUInt32BE(offsets.data + 4);
  if (chunks > METADATA_LIMITS.audioNodes || offsets.end - offsets.data !== 8 + chunks * 4)
    return invalid();
  const mapping = one(stbl.children, 'stsc');
  const maps = bytes.readUInt32BE(mapping.data + 4);
  if (
    !maps ||
    maps > chunks ||
    mapping.end - mapping.data !== 8 + maps * 12 ||
    bytes.readUInt32BE(mapping.data + 8) !== 1
  )
    return invalid();
  for (let i = 0; i < maps; i++) {
    const p = mapping.data + 8 + i * 12;
    if (
      !bytes.readUInt32BE(p + 4) ||
      bytes.readUInt32BE(p + 8) !== 1 ||
      bytes.readUInt32BE(p) > chunks ||
      (i > 0 && bytes.readUInt32BE(p) <= bytes.readUInt32BE(p - 12))
    )
      return invalid();
  }
  const mdats = root.filter((b) => b.name === 'mdat');
  let sample = 0;
  let previousEnd = 0;
  let map = 0;
  for (let chunk = 0; chunk < chunks; chunk++) {
    if (map + 1 < maps && bytes.readUInt32BE(mapping.data + 8 + (map + 1) * 12) === chunk + 1)
      map++;
    const perChunk = bytes.readUInt32BE(mapping.data + 12 + map * 12);
    if (sample + perChunk > samples) return invalid();
    const offset = bytes.readUInt32BE(offsets.data + 8 + chunk * 4);
    let length = 0;
    for (let s = 0; s < perChunk; s++, sample++) {
      const size = sampleSize(sample);
      if (!size) return invalid();
      length += size;
    }
    if (offset < previousEnd || !mdats.some((b) => offset >= b.data && offset + length <= b.end))
      return invalid();
    previousEnd = offset + length;
  }
  if (sample !== samples) return invalid();
  return ticks / timescale;
};

/** MPEG-1 Layer III only. Scan each complete frame; never trust Xing/VBRI duration tags. */
export const mp3Duration = (bytes: Buffer): number => {
  let offset = 0;
  let frames = 0;
  let rate = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes[3] !== 3 || bytes[5] !== 0) return invalid();
    const sizeBytes = [bytes[6], bytes[7], bytes[8], bytes[9]];
    if (sizeBytes.some((b) => b === undefined || b > 127)) return invalid();
    offset = 10 + sizeBytes.reduce<number>((n, b) => n * 128 + (b ?? 0), 0);
    if (offset > bytes.length) return invalid();
  }
  const end =
    bytes.length >= 128 && bytes.toString('ascii', bytes.length - 128, bytes.length - 125) === 'TAG'
      ? bytes.length - 128
      : bytes.length;
  while (offset < end) {
    if (++frames > METADATA_LIMITS.audioSamples) return limit();
    if (offset + 4 > end) return invalid();
    const h = bytes.readUInt32BE(offset);
    if (h >>> 21 !== 0x7ff || ((h >>> 19) & 3) !== 3 || ((h >>> 17) & 3) !== 1)
      throw new MetadataError('METADATA_UNSUPPORTED');
    const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][
      (h >>> 12) & 15
    ];
    const sampleRate = [44100, 48000, 32000][(h >>> 10) & 3];
    if (!bitrate || !sampleRate || (rate && sampleRate !== rate)) return invalid();
    rate = sampleRate;
    const size = Math.floor((144000 * bitrate) / rate) + ((h >>> 9) & 1);
    if (offset + size > end) return invalid();
    offset += size;
  }
  if (!frames) return invalid();
  return (frames * 1152) / rate;
};

export const wavDuration = (bytes: Buffer): number => {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  )
    return invalid();
  let format: Readonly<{ rate: number; align: number }> | undefined;
  let dataBytes: number | undefined;
  let chunks = 0;
  for (let offset = 12; offset < bytes.length; ) {
    if (++chunks > METADATA_LIMITS.audioNodes) return limit();
    if (offset + 8 > bytes.length) return invalid();
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const p = offset + 8;
    if (p + size > bytes.length) return invalid();
    if (name === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(p) !== 1)
        throw new MetadataError('METADATA_UNSUPPORTED');
      const channels = bytes.readUInt16LE(p + 2);
      const rate = bytes.readUInt32LE(p + 4);
      const align = bytes.readUInt16LE(p + 12);
      const bits = bytes.readUInt16LE(p + 14);
      if (
        !channels ||
        channels > 8 ||
        !rate ||
        rate > 384000 ||
        ![8, 16, 24, 32].includes(bits) ||
        align !== (channels * bits) / 8 ||
        bytes.readUInt32LE(p + 8) !== rate * align
      )
        return invalid();
      format = { rate, align };
    }
    if (name === 'data') {
      if (dataBytes !== undefined) return invalid();
      dataBytes = size;
    }
    offset = p + size + (size % 2);
    if (offset > bytes.length) return invalid();
  }
  if (!format || !dataBytes || dataBytes % format.align) return invalid();
  return dataBytes / format.align / format.rate;
};
