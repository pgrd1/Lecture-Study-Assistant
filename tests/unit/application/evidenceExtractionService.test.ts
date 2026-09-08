import { describe, expect, it } from 'vitest';
import type { SourceMetadataFacts } from '../../../src/shared/contracts/sourceMetadata';
import { withTempDirectory } from '../../testkit/tempDirectory';
import { classification, contentFixture, required, segment, textRecord } from './contentFixtures';

describe('EvidenceExtractionService', () => {
  it('normalizes validated extraction using media_extraction and reuses all three checkpoints after restart', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const first = await f.services().evidence.extractEvidence(f.input);
        expect(f.calls.map((v) => v.feature)).toEqual([
          'content_classification',
          'document_recognition',
          'media_extraction',
        ]);
        expect(required(f.calls[2]).blocks.some((b) => b.kind === 'source_file')).toBe(false);
        expect((await f.services().evidence.extractEvidence(f.input)).artifact.sha256).toBe(
          first.artifact.sha256,
        );
        expect(f.calls).toHaveLength(3);
      } finally {
        f.database.close();
      }
    });
  });
  it('rejects evidence that cites a missing page and leaves the complete extraction intact', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        f.response.value = (op, source) =>
          op.feature === 'content_classification'
            ? classification(source.id)
            : {
                segments: [
                  segment(source.id, {
                    kind: 'document',
                    page: op.feature === 'media_extraction' ? 999 : 1,
                  }),
                ],
              };
        await expect(f.services().evidence.extractEvidence(f.input)).rejects.toMatchObject({
          code: 'PROVIDER_OUTPUT_INVALID',
        });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction')).not.toBeNull();
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'evidence')).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });

  it('completes all 32 source operations in order per stage and records the complete upstream SHA', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root, 32);
      try {
        const result = await f.services().evidence.extractEvidence(f.input);
        expect(f.calls).toHaveLength(96);
        expect(result.value.segments.map((s) => s.sourceId)).toEqual(f.records.map((s) => s.id));
        expect(result.identity.operations.map((s) => s.sourceId)).toEqual(
          f.records.map((s) => s.id),
        );
        expect(result.identity.upstream).toEqual([
          {
            stage: 'extraction',
            sha256: required(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction'))
              .sha256,
          },
        ]);
      } finally {
        f.database.close();
      }
    });
  });

  it('misses downstream checkpoints when a complete upstream artifact changes', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const first = await f.services().evidence.extractEvidence(f.input);
        const upstream = await f.services().classification.classifySources(f.input);
        await f.artifacts.write({
          jobId: f.input.jobId,
          stage: 'classification',
          schemaVersion: 2,
          identity: upstream.identity,
          value: {
            classifications: upstream.value.classifications.map((c) => ({ ...c, confidence: 0.7 })),
          },
          operationReceipts: upstream.operationReceipts,
        });
        const next = await f.services().evidence.extractEvidence(f.input);
        expect(f.calls).toHaveLength(5);
        expect(next.identity.upstream).not.toEqual(first.identity.upstream);
      } finally {
        f.database.close();
      }
    });
  });

  it('rejects an otherwise valid source page absent from the extracted evidence', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        f.response.value = (op, source) =>
          op.feature === 'content_classification'
            ? classification(source.id)
            : {
                segments: [
                  segment(source.id, {
                    kind: 'document',
                    page: op.feature === 'media_extraction' ? 2 : 1,
                  }),
                ],
              };
        await expect(f.services().evidence.extractEvidence(f.input)).rejects.toMatchObject({
          code: 'PROVIDER_OUTPUT_INVALID',
        });
      } finally {
        f.database.close();
      }
    });
  });

  it('cancels the last stage without replacing either successful upstream checkpoint', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root, 2);
      const controller = new AbortController();
      try {
        f.response.value = (op, source) => {
          if (op.feature === 'content_classification') return classification(source.id);
          if (op.feature === 'media_extraction' && source.ordinal === 1) controller.abort();
          return { segments: [segment(source.id)] };
        };
        await expect(
          f.services().evidence.extractEvidence({ ...f.input, signal: controller.signal }),
        ).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'extraction')).not.toBeNull();
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'evidence')).toBeNull();
      } finally {
        f.database.close();
      }
    });
  });

  it.each(['audio', 'text', 'image'] as const)(
    'accepts contained %s evidence and rejects citations outside extracted bounds',
    async (kind) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const metadata: Record<typeof kind, SourceMetadataFacts> = {
            audio: { kind: 'audio', durationSeconds: 10, assurance: 'structural' },
            text: {
              kind: 'text',
              lineCount: 4,
              normalizedCodeUnits: 7,
              normalization: 'utf8-bom-crlf-v1',
            },
            image: {
              kind: 'image',
              encodedWidth: 20,
              encodedHeight: 10,
              displayWidth: 20,
              displayHeight: 10,
              orientation: 1,
              coordinateFrame: 'display-pixel-edges',
            },
          };
          const outer = {
            audio: { kind: 'audio', startMs: 1000, endMs: 5000 },
            text: { kind: 'text', startLine: 2, endLine: 3 },
            image: { kind: 'image', x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
          } as const;
          const inner = {
            audio: { kind: 'audio', startMs: 2000, endMs: 3000 },
            text: { kind: 'text', startLine: 2, endLine: 2 },
            image: { kind: 'image', x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
          } as const;
          const outside = {
            audio: { kind: 'audio', startMs: 0, endMs: 6000 },
            text: { kind: 'text', startLine: 1, endLine: 4 },
            image: { kind: 'image', x: 0, y: 0, width: 1, height: 1 },
          } as const;
          f.facts.value = metadata[kind];
          if (kind === 'text')
            f.replaceSource(await textRecord(root, required(f.records[0]), 'a\nb\nc\nd'));
          let invalid = false;
          f.response.value = (op, source) => {
            if (op.feature === 'content_classification')
              return { ...classification(source.id), sections: [] };
            const isEvidence = op.blocks.some(
              (block) => block.kind === 'source' && block.text.startsWith('{"segments":'),
            );
            return {
              segments: [
                segment(
                  source.id,
                  isEvidence ? (invalid ? outside[kind] : inner[kind]) : outer[kind],
                ),
              ],
            };
          };
          await f.services().evidence.extractEvidence(f.input);
          invalid = true;
          await expect(
            f.services().evidence.extractEvidence({
              ...f.input,
              prompts: { media_extraction: { oneOffInstructions: 'Check again' } },
            }),
          ).rejects.toMatchObject({ code: 'PROVIDER_OUTPUT_INVALID' });
        } finally {
          f.database.close();
        }
      });
    },
  );
});
