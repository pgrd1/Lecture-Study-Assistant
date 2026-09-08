import { describe, expect, it } from 'vitest';
import courseCatalog from '../../../protocol/examples/course-catalog.json';
import courseInboxRequest from '../../../protocol/examples/course-inbox-request.json';
import jobManifest from '../../../protocol/examples/job-manifest.json';
import rejectionReceipt from '../../../protocol/examples/rejection-receipt.json';
import statusReceipt from '../../../protocol/examples/status-receipt.json';
import courseInboxRequestJsonSchema from '../../../protocol/schemas/course-inbox-request.schema.json';
import jobManifestJsonSchema from '../../../protocol/schemas/job-manifest.schema.json';
import sourceBundleManifestV2JsonSchema from '../../../protocol/schemas/source-bundle-manifest-v2.schema.json';
import {
  CourseCatalogSchema,
  CourseInboxRequestSchema,
  QueueManifestSchema,
  RejectionReceiptSchema,
  StatusReceiptSchema,
} from '../../../src/shared/contracts/queue';
import { SourceBundleManifestV2Schema } from '../../../src/shared/contracts/sourceBundle';

type SourceSchemaBranch = Readonly<{
  properties?: Readonly<{
    fileName?: Readonly<{ pattern?: string }>;
    mediaType?: Readonly<{ const?: string }>;
  }>;
}>;

const sourceSchemaBranches = (): readonly SourceSchemaBranch[] => {
  const source = jobManifestJsonSchema.properties.source as Readonly<{
    anyOf?: readonly SourceSchemaBranch[];
    oneOf?: readonly SourceSchemaBranch[];
  }>;
  return source.oneOf ?? source.anyOf ?? [];
};

describe('public queue protocol examples', () => {
  it.each([
    ['course catalog', CourseCatalogSchema, courseCatalog],
    ['course inbox request', CourseInboxRequestSchema, courseInboxRequest],
    ['job manifest', QueueManifestSchema, jobManifest],
    ['status receipt', StatusReceiptSchema, statusReceipt],
    ['rejection receipt', RejectionReceiptSchema, rejectionReceipt],
  ] as const)('keeps the %s example valid', (_name, schema, example) => {
    expect(schema.safeParse(example).success).toBe(true);
  });

  it('contains no local paths, API keys, or lecture content', () => {
    const encoded = JSON.stringify({
      courseCatalog,
      courseInboxRequest,
      jobManifest,
      rejectionReceipt,
      statusReceipt,
    });
    expect(encoded).not.toMatch(/[A-Z]:\\|\/Users\/|sk-[A-Za-z0-9]{20,}/u);
    expect(encoded).not.toContain('audio bytes');
  });

  it('exports a closed course-inbox request schema at every nested object boundary', () => {
    expect(courseInboxRequestJsonSchema.additionalProperties).toBe(false);
    const course = courseInboxRequestJsonSchema.properties.course as Readonly<{
      additionalProperties?: boolean;
    }>;
    const source = courseInboxRequestJsonSchema.properties.source as Readonly<{
      anyOf?: readonly Readonly<{ additionalProperties?: boolean }>[];
      oneOf?: readonly Readonly<{ additionalProperties?: boolean }>[];
    }>;

    expect(course.additionalProperties).toBe(false);
    expect(
      (source.oneOf ?? source.anyOf ?? []).every((branch) => branch.additionalProperties === false),
    ).toBe(true);
  });

  it('exports display-name patterns that match the runtime course-inbox boundary', () => {
    const course = courseInboxRequestJsonSchema.properties.course as Readonly<{
      properties: Readonly<{
        name: Readonly<{ pattern?: string; allOf?: readonly Readonly<{ pattern?: string }>[] }>;
        professorName: Readonly<{
          pattern?: string;
          allOf?: readonly Readonly<{ pattern?: string }>[];
        }>;
      }>;
    }>;
    const matchesField = (
      field: Readonly<{ pattern?: string; allOf?: readonly Readonly<{ pattern?: string }>[] }>,
      value: string,
    ): boolean =>
      [field.pattern, ...(field.allOf ?? []).map((entry) => entry.pattern)]
        .filter((pattern): pattern is string => pattern !== undefined)
        .every((pattern) => new RegExp(pattern, 'u').test(value));

    expect(matchesField(course.properties.name, '운영체제')).toBe(true);
    expect(matchesField(course.properties.name, '   ')).toBe(false);
    for (const unsafeCharacter of ['\r', '\n', '\u0001', '\u0085', '\u2028', '\u2029']) {
      expect(matchesField(course.properties.name, `운영${unsafeCharacter}체제`)).toBe(false);
      expect(matchesField(course.properties.professorName, `교수${unsafeCharacter}님`)).toBe(false);
    }
  });

  it('exports the same path and media-extension restrictions enforced at runtime', () => {
    const branches = sourceSchemaBranches();
    expect(branches).toHaveLength(4);
    const audio = branches.find((branch) => branch.properties?.mediaType?.const === 'audio');
    const document = branches.find((branch) => branch.properties?.mediaType?.const === 'document');
    const audioPattern = new RegExp(audio?.properties?.fileName?.pattern ?? '(?!)', 'u');
    const documentPattern = new RegExp(document?.properties?.fileName?.pattern ?? '(?!)', 'u');

    expect(audioPattern.test('1주차 강의.m4a')).toBe(true);
    expect(audioPattern.test('1주차 강의.pdf')).toBe(false);
    expect(audioPattern.test('../강의.m4a')).toBe(false);
    expect(audioPattern.test('CON.m4a')).toBe(false);
    expect(audioPattern.test('강의.exe')).toBe(false);
    expect(documentPattern.test('강의자료.pdf')).toBe(true);
    expect(documentPattern.test('강의자료.mp3')).toBe(false);
  });

  it('exports a closed protocol-v2 multi-source schema', () => {
    expect(sourceBundleManifestV2JsonSchema.additionalProperties).toBe(false);
    expect(sourceBundleManifestV2JsonSchema.properties.protocolVersion.const).toBe(2);
    expect(sourceBundleManifestV2JsonSchema.properties.courseProvisioning.required).toEqual([
      'id',
      'name',
    ]);
    expect(
      SourceBundleManifestV2Schema.safeParse({
        protocolVersion: 2,
        jobId: '22222222-2222-4222-8222-222222222222',
        courseId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-09-01T00:00:00.000Z',
        summaryMode: 'standard',
        sources: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            fileName: 'lecture.m4a',
            mediaType: 'audio',
            sizeBytes: 12,
          },
        ],
      }).success,
    ).toBe(true);
  });
});
