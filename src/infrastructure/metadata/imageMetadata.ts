import { Buffer } from 'node:buffer';
import { METADATA_LIMITS, type SourceMetadataFacts } from '../../shared/contracts/sourceMetadata';
import { exifOrientation } from './exifOrientation';
import { invalid, limit } from './metadataError';

type Dimensions = Readonly<{ width: number; height: number }>;
const dimensions = (width: number, height: number): Dimensions => {
  if (width < 1 || height < 1) return invalid();
  if (
    width > METADATA_LIMITS.dimension ||
    height > METADATA_LIMITS.dimension ||
    width * height > METADATA_LIMITS.pixels
  )
    return limit();
  return { width, height };
};
const pngHeader = (data: Buffer): Dimensions => {
  if (data.length !== 13) return invalid();
  const depths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[data[9] ?? -1]?.includes(data[8] ?? 0) ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    (data[12] !== 0 && data[12] !== 1)
  )
    return invalid();
  return dimensions(data.readUInt32BE(0), data.readUInt32BE(4));
};
/** Header/chunk structure only: does not inflate pixels or authenticate CRC/decoded content. */
const pngDimensions = (bytes: Buffer): Dimensions => {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return invalid();
  let offset = 8;
  let chunks = 0;
  let header: Dimensions | undefined;
  let idatBytes = 0;
  let sawIdat = false;
  let dataEnded = false;
  let palette = false;
  while (offset < bytes.length) {
    if (++chunks > METADATA_LIMITS.imageSegments) return limit();
    if (bytes.length - offset < 12) return invalid();
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (
      size > 0x7fffffff ||
      size > bytes.length - offset - 12 ||
      !/^[A-Za-z]{2}[A-Z][A-Za-z]$/u.test(type)
    )
      return invalid();
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += size + 12;
    if (!header) {
      if (type !== 'IHDR') return invalid();
      header = pngHeader(data);
      continue;
    }
    if (type === 'IHDR' || type === 'eXIf' || ['acTL', 'fcTL', 'fdAT'].includes(type))
      return invalid();
    if (type === 'IDAT') {
      if (dataEnded || (bytes[25] === 3 && !palette)) return invalid();
      sawIdat = true;
      idatBytes += size;
    } else {
      if (sawIdat) dataEnded = true;
      if (type === 'IEND') {
        if (size !== 0 || idatBytes === 0 || offset !== bytes.length) return invalid();
        return header;
      }
      if (type === 'PLTE') {
        if (
          palette ||
          sawIdat ||
          size < 3 ||
          size > 768 ||
          size % 3 ||
          bytes[25] === 0 ||
          bytes[25] === 4
        )
          return invalid();
        palette = true;
      } else if (type[0] === type[0]?.toUpperCase()) return invalid();
    }
  }
  return invalid();
};

type Frame = Dimensions & Readonly<{ progressive: boolean; components: readonly number[] }>;
const jpegFrame = (data: Buffer, progressive: boolean): Frame => {
  const count = data[5] ?? 0;
  if (data.length !== 6 + 3 * count || data[0] !== 8 || count < 1 || count > 4) return invalid();
  const components: number[] = [];
  for (let at = 6; at < data.length; at += 3) {
    const id = data[at] as number;
    const sample = data[at + 1] as number;
    if (
      components.includes(id) ||
      sample >> 4 < 1 ||
      sample >> 4 > 4 ||
      (sample & 15) < 1 ||
      (sample & 15) > 4 ||
      (data[at + 2] as number) > 3
    )
      return invalid();
    components.push(id);
  }
  return { ...dimensions(data.readUInt16BE(3), data.readUInt16BE(1)), progressive, components };
};
const checkScan = (data: Buffer, frame: Frame): void => {
  const count = data[0] ?? 0;
  if (count < 1 || count > frame.components.length || data.length !== 4 + 2 * count) invalid();
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const id = data[1 + i * 2] as number;
    const tables = data[2 + i * 2] as number;
    if (!frame.components.includes(id) || seen.has(id) || tables >> 4 > 3 || (tables & 15) > 3)
      invalid();
    seen.add(id);
  }
  const start = data[data.length - 3] as number;
  const end = data[data.length - 2] as number;
  const approximation = data[data.length - 1] as number;
  const high = approximation >> 4;
  const low = approximation & 15;
  if (
    frame.progressive
      ? start > end ||
        end > 63 ||
        (start === 0 ? end !== 0 : count !== 1) ||
        high > 13 ||
        low > 13 ||
        (high !== 0 && high !== low + 1)
      : start !== 0 || end !== 63 || approximation !== 0
  )
    invalid();
};
/** Monotonic scan of entropy bytes: FF00 is stuffed data, RST0..7 are in-scan markers. */
const scanEnd = (bytes: Buffer, start: number): number => {
  let offset = start;
  let markers = 0;
  while (offset < bytes.length) {
    if (++markers > METADATA_LIMITS.imageScanMarkers) return limit();
    const markerStart = bytes.indexOf(255, offset);
    if (markerStart < 0) return invalid();
    let at = markerStart + 1;
    while (bytes[at] === 255) at++;
    const code = bytes[at];
    if (code === undefined) return invalid();
    if (code === 0 || (code >= 0xd0 && code <= 0xd7)) offset = at + 1;
    else return markerStart > start ? markerStart : invalid();
  }
  return invalid();
};
const jpegDimensions = (bytes: Buffer): Dimensions & Readonly<{ orientation: number }> => {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return invalid();
  let offset = 2;
  let segments = 0;
  let frame: Frame | undefined;
  let scanned = false;
  let orientation: number | undefined;
  while (offset < bytes.length) {
    if (++segments > METADATA_LIMITS.imageSegments) return limit();
    if (bytes[offset++] !== 255) return invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9)
      return frame && scanned && offset === bytes.length
        ? { ...frame, orientation: orientation ?? 1 }
        : invalid();
    if (
      marker === undefined ||
      (![0xc0, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) &&
        !(marker >= 0xe0 && marker <= 0xef))
    )
      return invalid();
    if (offset + 2 > bytes.length) return invalid();
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || size > bytes.length - offset) return invalid();
    const data = bytes.subarray(offset + 2, offset + size);
    offset += size;
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || scanned) return invalid();
      frame = jpegFrame(data, marker === 0xc2);
    } else if (marker === 0xe1 && data.toString('ascii', 0, 4) === 'Exif') {
      if (orientation !== undefined || !data.subarray(0, 6).equals(Buffer.from('Exif\0\0')))
        return invalid();
      orientation = exifOrientation(data.subarray(6));
    } else if (marker === 0xda) {
      if (!frame) return invalid();
      checkScan(data, frame);
      scanned = true;
      offset = scanEnd(bytes, offset);
    } else if (
      (marker === 0xdd && data.length !== 2) ||
      ((marker === 0xc4 || marker === 0xdb) && data.length === 0)
    )
      return invalid();
  }
  return invalid();
};
export const imageMetadata = (bytes: Buffer, extension: string): SourceMetadataFacts => {
  const result =
    extension === '.png' ? { ...pngDimensions(bytes), orientation: 1 } : jpegDimensions(bytes);
  return {
    kind: 'image',
    encodedWidth: result.width,
    encodedHeight: result.height,
    displayWidth: result.orientation >= 5 ? result.height : result.width,
    displayHeight: result.orientation >= 5 ? result.width : result.height,
    orientation: result.orientation,
    coordinateFrame: 'display-pixel-edges',
  };
};
