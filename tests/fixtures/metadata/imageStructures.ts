import { Buffer } from 'node:buffer';
import { box, jpeg, png } from './synthetic';

export const segment = (marker: number, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
};
export const pngChunk = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length);
  header.write(type, 4);
  // CRC bytes deliberately not claimed as integrity/decode proof by structural metadata tests.
  return Buffer.concat([header, payload, Buffer.alloc(4)]);
};
export const insertPng = (chunk: Buffer): Buffer =>
  Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
export const jpegExif = (orientation: number, bigEndian = false): Buffer => {
  const b = jpeg(orientation);
  if (!bigEndian) return b;
  b.write('MM', 12);
  b.writeUInt16BE(42, 14);
  b.writeUInt32BE(8, 16);
  b.writeUInt16BE(1, 20);
  b.writeUInt16BE(0x112, 22);
  b.writeUInt16BE(3, 24);
  b.writeUInt32BE(1, 26);
  b.writeUInt16BE(orientation, 30);
  return b;
};
export const jpegWithoutExif = (): Buffer =>
  Buffer.concat([jpeg().subarray(0, 2), jpeg().subarray(38)]);

/** Original RGB30x20 solid(102,153,204), Pillow12.3.0 quality85 progressive, decoded locally. */
export const progressiveJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wgARCAAUAB4DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAAABf/aAAwDAQACEAMQAAABtFuOAAB//8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQABBQJP/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQAGPwJP/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQABPyFP/9oADAMBAAIAAwAAABAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/EE//2Q==',
  'base64',
);

/** Zero-progress structures from the affected formats; never run in-process. */
export const spoofedImages = (): readonly Buffer[] => {
  const icns = Buffer.alloc(16);
  icns.write('icns');
  icns.writeUInt32BE(16, 4);
  icns.write('ic07', 8); // known type, zero chunk length
  const jxlp = box('jxlp', Buffer.alloc(4));
  jxlp.writeUInt32BE(0);
  const jxl = Buffer.concat([
    box('JXL ', Buffer.from([13, 10, 135, 10])),
    box('ftyp', Buffer.from('jxl ')),
    jxlp,
  ]);
  const ispe = box('ispe', Buffer.alloc(12));
  ispe.writeUInt32BE(0);
  const heif = Buffer.concat([
    box('ftyp', Buffer.from('heic')),
    box('meta', Buffer.concat([Buffer.alloc(4), box('iprp', box('ipco', ispe))])),
  ]);
  return [icns, jxl, heif];
};
