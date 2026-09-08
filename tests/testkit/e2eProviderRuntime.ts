import { randomUUID } from 'node:crypto';
import { AiProviderRouter } from '../../src/application/providers/aiProviderRouter';
import type { AiProviderAdapter } from '../../src/core/ports/aiProvider';
import type { SqliteRepositories } from '../../src/infrastructure/db/sqliteDatabase';
import { studyItems } from '../../src/shared/contracts/studyContent';

/** Build-only offline adapter. Production routing, verification and publishing remain real. */
export const createProviderRuntime = ({ repositories }: { repositories: SqliteRepositories }) => {
  for (const route of repositories.providerRoutes.list()) {
    if (route.providerId === 'gemini_api' && route.enabled && route.modelId === 'gemini-2.5-pro')
      continue;
    repositories.providerRoutes.update(
      {
        ...route,
        providerId: 'gemini_api',
        modelId: 'gemini-2.5-pro',
        enabled: true,
        revision: route.revision + 1,
      },
      route.revision,
    );
  }
  const previous = repositories.providerDiagnostics.get('gemini_api');
  if (previous?.status !== 'ready')
    repositories.providerDiagnostics.upsert(
      {
        providerId: 'gemini_api',
        status: 'ready',
        version: null,
        selectedModelId: 'gemini-2.5-pro',
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
  const adapter: AiProviderAdapter<'gemini_api'> = {
    id: 'gemini_api',
    execute: async (request) => {
      const block = request.blocks.find((item) => item.kind === 'source');
      const context = JSON.parse(block && block.kind !== 'source_file' ? block.text : '{}');
      const evidenceId = '44444444-4444-4444-8444-444444444444';
      const claim = (id: string) => ({
        id,
        text: 'An array stores ordered values.',
        evidenceIds: [evidenceId],
        status: 'source_supported',
        uncertainty: null,
      });
      let output: unknown;
      switch (request.feature) {
        case 'content_classification':
          output = {
            sourceId: context.sourceId,
            types: ['lecture_recording'],
            sections: [],
            facts: [],
            confidence: 1,
            uncertainty: null,
            sessionDate: null,
          };
          break;
        case 'document_recognition':
        case 'media_extraction':
        case 'audio_transcription':
          output = {
            segments: [
              {
                id: evidenceId,
                sourceId: context.sourceId,
                kind: 'definition',
                text: 'An array stores ordered values.',
                confidence: 1,
                locator: { kind: 'audio', startMs: 0, endMs: 1000 },
              },
            ],
          };
          break;
        case 'topic_clustering':
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
          break;
        case 'lecture_organize':
          output = {
            contentSchemaVersion: 2,
            topics: [
              {
                cluster: context.clusters.topics[0],
                contentMode: 'new_topic',
                outline: [claim('66666666-6666-4666-8666-666666666666')],
                explanations: [],
                definitions: [claim('77777777-7777-4777-8777-777777777777')],
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
          break;
        case 'course_question_answer':
          output = {
            answer: 'An array stores ordered values.',
            steps: [],
            example: '',
            uncertainty: '',
            evidenceIds: context.evidence
              .map((item: { evidenceId: string }) => item.evidenceId)
              .slice(0, 1),
          };
          break;
        default:
          output = {
            verificationSchemaVersion: 1,
            decisions: studyItems(context.candidate).map((item) => ({
              itemId: item.id,
              decision: 'accept',
              reason: 'Matches offered evidence',
              missingEvidenceIds: [],
            })),
          };
      }
      return {
        output: request.parseOutput(output),
        reportedModelId: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        completedAt: new Date().toISOString(),
      };
    },
    inspect: async () => {
      throw new Error('No live E2E inspection');
    },
    probe: async () => {
      throw new Error('No live E2E probe');
    },
    listModels: async () => {
      throw new Error('No live E2E model listing');
    },
    cancel: () => undefined,
  };
  const router = new AiProviderRouter({
    routes: repositories.providerRoutes,
    diagnostics: repositories.providerDiagnostics,
    invocations: repositories.providerInvocations,
    adapters: new Map([['gemini_api', adapter]]),
    clock: () => new Date().toISOString(),
    id: randomUUID,
  });
  return {
    router,
    providerIds: ['gemini_api'],
    secureDirectory: async () => undefined,
    shutdown: () => router.shutdown(),
  };
};
