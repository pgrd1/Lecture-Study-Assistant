import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentClassificationService } from '../../../src/application/content/contentClassificationService';
import { LocalSourceMetadata } from '../../../src/infrastructure/metadata/localSourceMetadata';
import { MetadataError } from '../../../src/infrastructure/metadata/metadataError';
import { ContentClassificationResultSchema } from '../../../src/shared/contracts/contentClassification';
import { PipelineStageIdentitySchema } from '../../../src/shared/contracts/pipelineArtifact';
import type { SourceMetadataFacts } from '../../../src/shared/contracts/sourceMetadata';
import {
  METADATA_PARSER_VERSION,
  METADATA_POLICY_VERSION,
  TrustedSourceMetadataSchema,
} from '../../../src/shared/contracts/sourceMetadata';
import { withTempDirectory } from '../../testkit/tempDirectory';
import { classification, contentFixture, required, textRecord } from './contentFixtures';

describe('ContentClassificationService', () => {
  it('keeps cancellation ahead of a concurrent owned metadata timeout', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const controller = new AbortController();
      try {
        f.metadata.measure.mockImplementation(async () => {
          controller.abort();
          throw new MetadataError('METADATA_TIMEOUT');
        });
        await expect(
          f.services().classification.classifySources({ ...f.input, signal: controller.signal }),
        ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
        expect(f.calls).toHaveLength(0);
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });
  it.each([
    ['BOM and CRLF', '\ufeffA\r\nB\rC\n', 'A\nB\rC\n', 3, 6],
    ['lone CR', 'A\rB', 'A\rB', 1, 3],
    ['one BOM only', '\ufeff\ufeffA', '\ufeffA', 1, 2],
  ] as const)(
    'measures and sends identical text for %s',
    async (_name, bytes, normalized, lines, units) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const record = await textRecord(root, required(f.records[0]), bytes);
          f.replaceSource(record);
          const metadata = new LocalSourceMetadata({
            workerPath: join(process.cwd(), '.vite/build/metadata-worker.mjs'),
          });
          const measured = await metadata.measure(record);
          expect(measured.facts).toEqual({
            kind: 'text',
            lineCount: lines,
            normalizedCodeUnits: units,
            normalization: 'utf8-bom-crlf-v1',
          });
          f.response.value = () => ({
            ...classification(record.id),
            sections: [
              {
                locator: { kind: 'text', startLine: 1, endLine: lines },
                types: ['reference'],
                confidence: 1,
                uncertainty: null,
              },
            ],
          });
          const service = new ContentClassificationService({ ...f.dependencies, metadata });
          await service.classifySources(f.input);
          expect(f.calls[0]?.blocks).toContainEqual({
            role: 'user',
            kind: 'source',
            text: normalized,
          });
          expect(
            TrustedSourceMetadataSchema.safeParse({
              ...measured,
              parserVersion:
                'metadata-3_mm-11.15.0_pdf-6.3.289_pdflib-1.17.1_image-local-1_zip-3.4.0_xml-6.0.0',
              policyVersion: 'local-bounds-v3',
            }).success,
          ).toBe(false);
        } finally {
          f.database.close();
        }
      });
    },
  );
  it('classifies all 32 sources in order with multiple roles, no invented dates, and reuses a complete checkpoint', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root, 32);
      try {
        const result = await f.services().classification.classifySources(f.input);
        expect(result.value.classifications.map((v) => v.sourceId)).toEqual(
          f.records.map((v) => v.id),
        );
        expect(result.value.classifications[0]).toMatchObject({
          types: ['syllabus', 'reference'],
          facts: [],
          sessionDate: null,
        });
        expect(f.calls).toHaveLength(32);
        expect(result.operationReceipts).toEqual(
          f.calls.map((op, i) => ({
            sourceId: required(f.records[i]).id,
            requestId: op.requestId,
          })),
        );
        expect(
          f.calls.every((op) => op.blocks.filter((b) => b.kind === 'source_file').length === 1),
        ).toBe(true);
        expect(result.artifact.schemaVersion).toBe(2);
        expect((await f.services().classification.classifySources(f.input)).artifact.sha256).toBe(
          result.artifact.sha256,
        );
        expect(f.calls).toHaveLength(32);
      } finally {
        f.database.close();
      }
    });
  });
  it('rejects a foreign source in a later response without writing a partial checkpoint', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root, 3);
      try {
        f.response.value = (_, source) =>
          classification(source.ordinal === 2 ? required(f.records[0]).id : source.id);
        await expect(f.services().classification.classifySources(f.input)).rejects.toMatchObject({
          code: 'PROVIDER_OUTPUT_INVALID',
        });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
        expect(f.calls).toHaveLength(3);
      } finally {
        f.database.close();
      }
    });
  });
  it('closes and bounds the aggregate schema and rejects duplicate source IDs', () => {
    const value = classification('33333333-3333-4333-8333-333333333333');
    for (const input of [
      { classifications: [] },
      { classifications: [value, value] },
      { classifications: [value], extra: true },
      { classifications: Array.from({ length: 33 }, () => value) },
    ])
      expect(() => ContentClassificationResultSchema.parse(input)).toThrow();
  });

  it.each([
    [
      { kind: 'pdf', pageCount: 10 },
      { kind: 'document', page: 11 },
    ],
    [
      { kind: 'audio', durationSeconds: 10, assurance: 'structural' },
      { kind: 'audio', startMs: 0, endMs: 10001 },
    ],
    [
      { kind: 'presentation', slideParts: ['ppt/slides/slide1.xml'] },
      { kind: 'slide', slide: 2 },
    ],
    [
      { kind: 'text', lineCount: 2, normalizedCodeUnits: 3, normalization: 'utf8-bom-crlf-v1' },
      { kind: 'text', startLine: 1, endLine: 3 },
    ],
    [
      {
        kind: 'image',
        encodedWidth: 20,
        encodedHeight: 10,
        displayWidth: 20,
        displayHeight: 10,
        orientation: 1,
        coordinateFrame: 'display-pixel-edges',
      },
      { kind: 'image', x: 0.9, y: 0, width: 0.2, height: 1 },
    ],
  ])('rejects invalid classification section bounds %#', async (facts, locator) => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        f.facts.value = facts as SourceMetadataFacts;
        // Text is tested at the parsing boundary, independently of the verified file-read test.
        f.metadata.measure.mockImplementation(async (source) => ({
          sourceId: source.id,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          parserVersion: METADATA_PARSER_VERSION,
          policyVersion: METADATA_POLICY_VERSION,
          facts: facts as SourceMetadataFacts,
        }));
        f.response.value = (_, source) => ({
          ...classification(source.id),
          sections: [{ locator, types: ['syllabus'], confidence: 1, uncertainty: null }],
        });
        if (facts.kind === 'text') {
          const { textRecord } = await import('./contentFixtures');
          f.replaceSource(await textRecord(root, required(f.records[0]), 'a\nb'));
        }
        await expect(f.services().classification.classifySources(f.input)).rejects.toMatchObject({
          code: 'PROVIDER_OUTPUT_INVALID',
        });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });

  it.each(['prompt', 'route', 'facts', 'policy', 'parser', 'sha'] as const)(
    'misses a checkpoint after %s identity changes',
    async (kind) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const first = await f.services().classification.classifySources(f.input);
          if (kind === 'facts') f.facts.value = { kind: 'pdf', pageCount: 11 };
          if (kind === 'route') {
            const route = required(f.repositories.providerRoutes.get('content_classification'));
            f.repositories.providerRoutes.update(
              { ...route, revision: route.revision + 1 },
              route.revision,
            );
          }
          if (kind === 'sha')
            f.replaceSource({ ...required(f.records[0]), sha256: 'd'.repeat(64) });
          if (kind === 'policy' || kind === 'parser') {
            const identity = PipelineStageIdentitySchema.parse({
              ...first.identity,
              sources: first.identity.sources.map((source) => ({
                ...source,
                metadata: {
                  ...source.metadata,
                  [kind === 'policy' ? 'policyVersion' : 'parserVersion']: 'previous-version',
                },
              })),
            });
            await f.artifacts.write({
              jobId: f.input.jobId,
              stage: 'classification',
              schemaVersion: 2,
              identity,
              value: first.value,
              operationReceipts: first.operationReceipts,
            });
          }
          const nextInput =
            kind === 'prompt'
              ? {
                  ...f.input,
                  prompts: {
                    content_classification: { oneOffInstructions: 'Use explicit sections.' },
                  },
                }
              : f.input;
          await f.services().classification.classifySources(nextInput);
          expect(f.calls).toHaveLength(2);
        } finally {
          f.database.close();
        }
      });
    },
  );

  it('never reuses a singular v1 checkpoint carrying a legacy v2 identity as a current aggregate', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const first = await f.services().classification.classifySources(f.input);
        const { contextSha256: _contextHash, ...legacy } = first.identity;
        await f.artifacts.write({
          jobId: f.input.jobId,
          stage: 'classification',
          schemaVersion: 1,
          identity: { ...legacy, identityVersion: 2, operationVersion: 'content-stages-v1' },
          value: required(first.value.classifications[0]),
        });
        expect(
          (await f.services().classification.classifySources(f.input)).artifact.schemaVersion,
        ).toBe(2);
        expect(f.calls).toHaveLength(2);
      } finally {
        f.database.close();
      }
    });
  });

  it('rejects invalid facts, closed-schema extras and source paths without publication', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        for (const make of [
          () => ({ ...classification(required(f.records[0]).id), secret: 'extra' }),
          () => ({
            ...classification(required(f.records[0]).id),
            uncertainty: required(f.records[0]).stagedPath,
          }),
          () => ({
            ...classification(required(f.records[0]).id),
            facts: [
              {
                kind: 'candidate_exam_date',
                text: 'date',
                locator: { kind: 'document', page: 999 },
                confidence: 1,
                uncertainty: null,
                date: '2026-09-09',
                weightPercent: null,
              },
            ],
          }),
        ]) {
          f.response.value = make;
          await expect(f.services().classification.classifySources(f.input)).rejects.toMatchObject({
            code: 'PROVIDER_OUTPUT_INVALID',
          });
          expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
        }
      } finally {
        f.database.close();
      }
    });
  });

  it('treats a corrupt committed payload as an error, with zero new provider calls', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const first = await f.services().classification.classifySources(f.input);
        await writeFile(join(root, 'artifacts', first.artifact.relativePath), '{}');
        await expect(f.services().classification.classifySources(f.input)).rejects.toThrow(
          'PIPELINE_ARTIFACT_READ_FAILED',
        );
        expect(f.calls).toHaveLength(1);
      } finally {
        f.database.close();
      }
    });
  });

  it.each(['before', 'metadata', 'response'] as const)(
    'does not call or checkpoint after cancellation at %s',
    async (point) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        const controller = new AbortController();
        try {
          if (point === 'before') controller.abort();
          if (point === 'metadata') {
            const measure = required(f.metadata.measure.getMockImplementation());
            f.metadata.measure.mockImplementation(async (source) => {
              controller.abort();
              return measure(source);
            });
          }
          if (point === 'response')
            f.response.value = (_, source) => {
              controller.abort();
              return classification(source.id);
            };
          await expect(
            f.services().classification.classifySources({ ...f.input, signal: controller.signal }),
          ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
          expect(f.calls).toHaveLength(point === 'response' ? 1 : 0);
          expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
        } finally {
          f.database.close();
        }
      });
    },
  );

  it('refuses route revision changes during a call and emits protected/system plus user/instruction only', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        f.response.value = (op, source) => {
          expect(op.blocks.filter((b) => b.role === 'system')).toHaveLength(1);
          expect(op.blocks[0]).toMatchObject({ role: 'system', kind: 'instruction' });
          expect(op.blocks[1]).toMatchObject({ role: 'user', kind: 'instruction' });
          expect(op.outputJsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
          });
          const route = required(f.repositories.providerRoutes.get('content_classification'));
          f.repositories.providerRoutes.update(
            { ...route, revision: route.revision + 1 },
            route.revision,
          );
          return classification(source.id);
        };
        await expect(f.services().classification.classifySources(f.input)).rejects.toMatchObject({
          code: 'PROVIDER_NOT_READY',
        });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });
});
