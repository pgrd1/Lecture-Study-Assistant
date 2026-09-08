import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ContentClassificationService } from '../../../src/application/content/contentClassificationService';
import { EvidenceExtractionService } from '../../../src/application/content/evidenceExtractionService';
import { SourceExtractionService } from '../../../src/application/content/sourceExtractionService';
import { PromptComposer } from '../../../src/application/prompts/promptComposer';
import type { ProviderOperation } from '../../../src/core/ports/aiProvider';
import { createRepositories, openDatabase } from '../../../src/infrastructure/db/sqliteDatabase';
import { createJsonPipelineArtifactStore } from '../../../src/infrastructure/filesystem/jsonPipelineArtifactStore';
import type { JsonValue } from '../../../src/shared/contracts/provider';
import type { SourceRecord } from '../../../src/shared/contracts/sourceBundle';
import {
  METADATA_PARSER_VERSION,
  METADATA_POLICY_VERSION,
  type SourceMetadataFacts,
} from '../../../src/shared/contracts/sourceMetadata';
import { courseFixture, jobFixture } from '../../testkit/fixtures';

export const classification = (sourceId: string) => ({
  sourceId,
  types: ['syllabus', 'reference'],
  sections: [
    {
      locator: { kind: 'document', page: 1 },
      types: ['syllabus'],
      confidence: 0.9,
      uncertainty: null,
    },
    {
      locator: { kind: 'document', page: 2 },
      types: ['reference'],
      confidence: 0.8,
      uncertainty: null,
    },
  ],
  facts: [],
  confidence: 0.9,
  uncertainty: null,
  sessionDate: null,
});
export const required = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error('Missing expected fixture value');
  return value;
};
export const segment = (sourceId: string, locator: JsonValue = { kind: 'document', page: 1 }) => ({
  id: randomUUID(),
  sourceId,
  kind: 'formula',
  text: '운동 Energy E = mc²; 3.14 kg·m/s²',
  confidence: 0.9,
  locator,
});

export async function contentFixture(root: string, count = 1) {
  const database = openDatabase(join(root, 'study.sqlite'));
  const repositories = createRepositories(database);
  repositories.courses.insert(courseFixture());
  repositories.jobs.insert(jobFixture());
  const bundleId = randomUUID();
  const records: SourceRecord[] = Array.from({ length: count }, (_, ordinal) => ({
    id: randomUUID(),
    bundleId,
    ordinal,
    originalFileName: `source-${ordinal}.pdf`,
    mediaType: 'document',
    stagedPath: join(root, `source-${ordinal}.pdf`),
    sha256: createHash('sha256').update(String(ordinal)).digest('hex'),
    sizeBytes: 10,
  }));
  repositories.sourceBundles.insert(
    {
      id: bundleId,
      jobId: jobFixture().id,
      manifestSha256: 'b'.repeat(64),
      sourceCount: count,
      totalBytes: count * 10,
      stagingDirectoryPath: root,
      createdAt: '2026-09-07T00:00:00.000Z',
    },
    records,
  );
  for (const feature of [
    'content_classification',
    'audio_transcription',
    'document_recognition',
    'media_extraction',
  ] as const) {
    const route = repositories.providerRoutes.get(feature);
    if (!route) throw new Error('Missing fixture route');
    repositories.providerRoutes.update(
      {
        ...route,
        providerId: 'openai_api',
        modelId: feature,
        enabled: true,
        revision: route.revision + 1,
      },
      route.revision,
    );
  }
  await mkdir(join(root, 'artifacts'));
  const artifacts = await createJsonPipelineArtifactStore(
    join(root, 'artifacts'),
    repositories.pipelineArtifacts,
  );
  const calls: ProviderOperation<JsonValue>[] = [];
  const response = {
    value: (op: ProviderOperation<JsonValue>, source: SourceRecord): unknown =>
      op.feature === 'content_classification'
        ? classification(source.id)
        : { segments: [segment(source.id)] },
  };
  const router = {
    execute: async <T extends JsonValue>(op: ProviderOperation<T>) => {
      calls.push(op);
      const block = op.blocks.find((v) => v.kind === 'source' && v.text.startsWith('{"sourceId"'));
      const id = block && block.kind !== 'source_file' ? JSON.parse(block.text).sourceId : null;
      const source = records.find((v) => v.id === id);
      if (!source) throw new Error('Missing request source identity');
      return {
        output: response.value(op, source) as T,
        reportedModelId: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        completedAt: '2026-09-07T00:00:00.000Z',
      };
    },
  };
  const facts = { value: { kind: 'pdf', pageCount: 10 } as SourceMetadataFacts };
  const perSourceFacts = new Map<string, SourceMetadataFacts>();
  const metadata = {
    measure: vi.fn(
      async (source: SourceRecord) =>
        ({
          sourceId: source.id,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          parserVersion: METADATA_PARSER_VERSION,
          policyVersion: METADATA_POLICY_VERSION,
          facts: perSourceFacts.get(source.id) ?? facts.value,
        }) as const,
    ),
  };
  const dependencies = {
    bundles: repositories.sourceBundles,
    routes: repositories.providerRoutes,
    artifacts,
    router,
    metadata,
    composer: new PromptComposer(),
  };
  const services = () => ({
    classification: new ContentClassificationService(dependencies),
    extraction: new SourceExtractionService(dependencies),
    evidence: new EvidenceExtractionService(dependencies),
  });
  const input = {
    jobId: jobFixture().id,
    courseId: courseFixture().id,
    signal: new AbortController().signal,
  };
  const replaceSource = (record: SourceRecord) => {
    records[record.ordinal] = record;
    database
      .prepare(
        'UPDATE source_records SET original_file_name = ?, media_type = ?, staged_path = ?, sha256 = ?, size_bytes = ? WHERE id = ?',
      )
      .run(
        record.originalFileName,
        record.mediaType,
        record.stagedPath,
        record.sha256,
        record.sizeBytes,
        record.id,
      );
    database.prepare('UPDATE source_bundles SET total_bytes = ? WHERE id = ?').run(
      records.reduce((sum, r) => sum + r.sizeBytes, 0),
      bundleId,
    );
  };
  return {
    database,
    repositories,
    records,
    artifacts,
    calls,
    response,
    facts,
    perSourceFacts,
    metadata,
    dependencies,
    services,
    input,
    replaceSource,
  };
}

export async function textRecord(
  root: string,
  source: SourceRecord,
  text: string,
): Promise<SourceRecord> {
  const bytes = Buffer.from(text, 'utf8');
  const path = join(root, 'source.txt');
  await writeFile(path, bytes);
  return {
    ...source,
    originalFileName: 'source.txt',
    stagedPath: path,
    mediaType: 'document',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
