import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AiProviderRouter } from '../../src/application/providers/aiProviderRouter';
import type { AiProviderAdapter } from '../../src/core/ports/aiProvider';
import type { SourceMetadataPort } from '../../src/core/ports/sourceMetadata';
import type { SqliteRepositories } from '../../src/infrastructure/db/sqliteDatabase';
import { LocalSourceMetadata } from '../../src/infrastructure/metadata/localSourceMetadata';
import { createContentPipelineRuntime } from '../../src/main/contentPipelineRuntime';
import { studyItems } from '../../src/shared/contracts/studyContent';

export const offlineEvidenceRuntime = async (
  root: string,
  repositories: SqliteRepositories,
  metadata?: SourceMetadataPort,
) => {
  const artifactRoot = join(root, 'pipeline-artifacts');
  await mkdir(artifactRoot, { recursive: true });
  for (const route of repositories.providerRoutes.list())
    repositories.providerRoutes.update(
      {
        ...route,
        providerId: 'openai_api',
        modelId: 'gpt-5.5',
        enabled: true,
        revision: route.revision + 1,
      },
      route.revision,
    );
  const previous = repositories.providerDiagnostics.get('openai_api');
  repositories.providerDiagnostics.upsert(
    {
      providerId: 'openai_api',
      status: 'ready',
      version: null,
      selectedModelId: 'gpt-5.5',
      reportedModelId: null,
      credentialPresent: true,
      credentialScope: 'not_applicable',
      sharedCredentialConsentAt: null,
      sharedCredentialConsentVersion: null,
      cliBinding: null,
      providerManagedHistory: false,
      checkedAt: null,
      latencyMs: null,
      errorCode: null,
      revision: previous ? previous.revision + 1 : 0,
    },
    previous?.revision ?? null,
  );
  const adapter: AiProviderAdapter<'openai_api'> = {
    id: 'openai_api',
    execute: async (request) => {
      const source = request.blocks.find((block) => block.kind === 'source');
      const context = JSON.parse(source && source.kind !== 'source_file' ? source.text : '{}');
      const evidenceId = '44444444-4444-4444-8444-444444444444';
      const locator = { kind: 'text', startLine: 1, endLine: 1 };
      let output: unknown;
      if (request.feature === 'content_classification')
        output = {
          sourceId: context.sourceId,
          types: ['reference'],
          sections: [],
          facts: [],
          confidence: 1,
          uncertainty: null,
          sessionDate: null,
        };
      else if (request.feature === 'document_recognition' || request.feature === 'media_extraction')
        output = {
          segments: [
            {
              id: evidenceId,
              sourceId: context.sourceId,
              kind: 'definition',
              text: 'An array stores ordered values.',
              confidence: 1,
              locator,
            },
          ],
        };
      else if (request.feature === 'topic_clustering')
        output = {
          contentSchemaVersion: 2,
          topics: [
            {
              id: '55555555-5555-4555-8555-555555555555',
              title: 'Arrays',
              action: 'create',
              existingTopicId: null,
              evidenceIds: [evidenceId],
              uncertainty: null,
              sessionDates: [],
            },
          ],
        };
      else if (request.feature === 'lecture_organize')
        output = {
          contentSchemaVersion: 2,
          topics: [
            {
              cluster: context.clusters.topics[0],
              contentMode: 'new_topic',
              outline: [
                {
                  id: '66666666-6666-4666-8666-666666666666',
                  text: 'An array stores ordered values.',
                  evidenceIds: [evidenceId],
                  status: 'source_supported',
                  uncertainty: null,
                },
              ],
              explanations: [],
              definitions: [],
              formulas: [],
              examples: [],
              exceptions: [],
              misconceptions: [],
              professorSignals: [],
              conflicts: [],
              citations: context.evidence.segments.map(
                (segment: { id: string; sourceId: string; locator: unknown }) => ({
                  evidenceId: segment.id,
                  sourceId: segment.sourceId,
                  locator: segment.locator,
                }),
              ),
              sessions: [],
            },
          ],
        };
      else
        output = {
          verificationSchemaVersion: 1,
          decisions: studyItems(context.candidate).map((item) => ({
            itemId: item.id,
            decision: 'accept',
            reason: 'Matches source',
            missingEvidenceIds: [],
          })),
        };
      return {
        output: request.parseOutput(output),
        reportedModelId: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        completedAt: new Date().toISOString(),
      };
    },
    inspect: async () => {
      throw new Error('No live inspection');
    },
    probe: async () => {
      throw new Error('No live probe');
    },
    listModels: async () => {
      throw new Error('No live listing');
    },
    cancel: () => undefined,
  };
  const router = new AiProviderRouter({
    routes: repositories.providerRoutes,
    diagnostics: repositories.providerDiagnostics,
    invocations: repositories.providerInvocations,
    adapters: new Map([['openai_api', adapter]]),
    clock: () => new Date().toISOString(),
    id: randomUUID,
  });
  return createContentPipelineRuntime({
    repositories,
    userDataRoot: root,
    artifactRoot,
    providerRuntime: { router },
    metadata:
      metadata ??
      new LocalSourceMetadata({
        workerPath: join(process.cwd(), '.vite/build/metadata-worker.mjs'),
      }),
  });
};
