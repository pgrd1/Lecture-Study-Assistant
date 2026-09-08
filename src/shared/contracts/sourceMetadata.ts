import { z } from 'zod';
import { SourceLocatorSchema } from './evidence';

export const METADATA_POLICY_VERSION = 'local-bounds-v4';
export const METADATA_PARSER_VERSION =
  'metadata-4_mm-11.15.0_pdf-6.3.289_pdflib-1.17.1_image-local-1_zip-3.4.0_xml-6.0.0';
export const METADATA_LIMITS = Object.freeze({
  sourceBytes: 64_000_000,
  deadlineMs: 15_000,
  pages: 2000,
  pdfTreeDepth: 64,
  pdfTreeNodes: 4096,
  pdfTreeFanout: 2000,
  durationSeconds: 86400,
  dimension: 32768,
  pixels: 100_000_000,
  imageSegments: 4096,
  imageScanMarkers: 100000,
  imageIfds: 8,
  imageIfdEntries: 256,
  zipEntries: 10000,
  xmlBytes: 2_097_152,
  totalXmlBytes: 16_777_216,
  xmlDepth: 64,
  xmlNodes: 100000,
  audioNodes: 100000,
  audioSamples: 4_000_000,
  outputBytes: 262144,
});
const dimension = z.int().min(1).max(METADATA_LIMITS.dimension);
export const SourceMetadataFactsSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('audio'),
      durationSeconds: z.number().positive().max(METADATA_LIMITS.durationSeconds),
      assurance: z.literal('structural'),
    }),
    z.strictObject({
      kind: z.literal('pdf'),
      pageCount: z.int().min(1).max(METADATA_LIMITS.pages),
    }),
    z
      .strictObject({
        kind: z.literal('presentation'),
        slideParts: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(METADATA_LIMITS.pages)
          .readonly(),
      })
      .refine((v) => new Set(v.slideParts).size === v.slideParts.length),
    z
      .strictObject({
        kind: z.literal('image'),
        encodedWidth: dimension,
        encodedHeight: dimension,
        displayWidth: dimension,
        displayHeight: dimension,
        orientation: z.int().min(1).max(8),
        coordinateFrame: z.literal('display-pixel-edges'),
      })
      .refine(
        (v) =>
          v.encodedWidth * v.encodedHeight <= METADATA_LIMITS.pixels &&
          v.displayWidth === (v.orientation >= 5 ? v.encodedHeight : v.encodedWidth) &&
          v.displayHeight === (v.orientation >= 5 ? v.encodedWidth : v.encodedHeight),
      ),
    z.strictObject({
      kind: z.literal('text'),
      lineCount: z.int().min(1).max(1_000_000),
      normalizedCodeUnits: z.int().min(1).max(8_000_000),
      normalization: z.literal('utf8-bom-crlf-v1'),
    }),
  ])
  .readonly();
export type SourceMetadataFacts = z.infer<typeof SourceMetadataFactsSchema>;
export const TrustedSourceMetadataSchema = z
  .strictObject({
    sourceId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.int().min(1).max(METADATA_LIMITS.sourceBytes),
    parserVersion: z.literal(METADATA_PARSER_VERSION),
    policyVersion: z.literal(METADATA_POLICY_VERSION),
    facts: SourceMetadataFactsSchema,
  })
  .readonly();
export type TrustedSourceMetadata = z.infer<typeof TrustedSourceMetadataSchema>;

/** Evidence image fractions refer to the displayed EXIF frame, never encoded dimensions. */
export const metadataContainsLocator = (facts: SourceMetadataFacts, locator: unknown): boolean => {
  const parsed = SourceLocatorSchema.safeParse(locator);
  if (!parsed.success) return false;
  const value = parsed.data;
  switch (facts.kind) {
    case 'audio':
      return value.kind === 'audio' && value.endMs <= facts.durationSeconds * 1000;
    case 'pdf':
      return value.kind === 'document' && value.page <= facts.pageCount;
    case 'presentation':
      return value.kind === 'slide' && value.slide <= facts.slideParts.length;
    case 'text':
      return value.kind === 'text' && value.endLine <= facts.lineCount;
    case 'image':
      return value.kind === 'image';
  }
};

/** Maps encoded pixel edges into the displayed EXIF frame, including mirrored orientations. */
export const displayedImagePoint = (
  x: number,
  y: number,
  width: number,
  height: number,
  orientation: number,
): readonly [number, number] => {
  if (
    ![x, y, width, height, orientation].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    x < 0 ||
    y < 0 ||
    x > width ||
    y > height ||
    !Number.isInteger(orientation)
  )
    throw new TypeError('METADATA_BOUNDS');
  switch (orientation) {
    case 1:
      return [x, y];
    case 2:
      return [width - x, y];
    case 3:
      return [width - x, height - y];
    case 4:
      return [x, height - y];
    case 5:
      return [y, x];
    case 6:
      return [height - y, x];
    case 7:
      return [height - y, width - x];
    case 8:
      return [y, width - x];
    default:
      throw new TypeError('METADATA_BOUNDS');
  }
};
