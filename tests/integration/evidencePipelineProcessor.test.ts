import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidencePipelineProcessor } from '../../src/application/content/evidencePipelineProcessor';
import { AiProviderRouter } from '../../src/application/providers/aiProviderRouter';
import type { AiProviderAdapter, ProviderOperation } from '../../src/core/ports/aiProvider';
import { sha256CanonicalJson } from '../../src/core/providers/canonicalJson';
import { createContentPipelineRuntime } from '../../src/main/contentPipelineRuntime';
import {
  PipelineArtifactWriteSchema,
  StudyStageIdentitySchema,
} from '../../src/shared/contracts/pipelineArtifact';
import type { JsonValue } from '../../src/shared/contracts/provider';
import { studyItems } from '../../src/shared/contracts/studyContent';
import { readyCodexDiagnostic } from '../testkit/readyCodexDiagnostic';
import { withTempDirectory } from '../testkit/tempDirectory';
import { contentFixture, required } from '../unit/application/contentFixtures';

const pipelineFixture = async (root: string, count = 1) => {
  const f = await contentFixture(root, count);
  const bundle = required(f.repositories.sourceBundles.getByJobId(f.input.jobId));
  const job = required(f.repositories.jobs.get(f.input.jobId));
  f.database
    .prepare('UPDATE jobs SET source_bundle_id = ?, source_count = ? WHERE id = ?')
    .run(bundle.id, count, job.id);
  for (const feature of ['topic_clustering', 'lecture_organize', 'lecture_verify'] as const) {
    const route = required(f.repositories.providerRoutes.get(feature));
    f.repositories.providerRoutes.update(
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
  const calls: ProviderOperation<JsonValue>[] = [];
  const behavior = {
    fail: '',
    edit: (_operation: ProviderOperation<JsonValue>, output: unknown): unknown => output,
  };
  const router = {
    execute: async <T extends JsonValue>(operation: ProviderOperation<T>) => {
      if (!['topic_clustering', 'lecture_organize', 'lecture_verify'].includes(operation.feature))
        return f.dependencies.router.execute(operation);
      calls.push(operation);
      if (behavior.fail === operation.feature) throw new Error('test provider failure');
      const block = operation.blocks.find((b) => b.kind === 'source');
      const context = JSON.parse(block && block.kind !== 'source_file' ? block.text : '{}');
      let output: unknown;
      if (operation.feature === 'topic_clustering')
        output = {
          contentSchemaVersion: 2,
          topics: ['시간복잡도', '배열', '연결리스트'].map((title) => ({
            id: randomUUID(),
            title,
            action: 'create',
            existingTopicId: null,
            evidenceIds: context.evidence.segments.map((e: { id: string }) => e.id),
            uncertainty: null,
            sessionDates: [],
          })),
        };
      else if (operation.feature === 'lecture_organize')
        output = {
          contentSchemaVersion: 2,
          topics: context.clusters.topics.map((cluster: object) => ({
            cluster,
            contentMode: 'new_topic',
            outline: [
              {
                id: randomUUID(),
                text: 'E = mc²',
                evidenceIds: context.evidence.segments.map((e: { id: string }) => e.id),
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
              (e: { id: string; sourceId: string; locator: unknown }) => ({
                evidenceId: e.id,
                sourceId: e.sourceId,
                locator: e.locator,
              }),
            ),
            sessions: [],
          })),
        };
      else
        output = {
          verificationSchemaVersion: 1,
          decisions: studyItems(context.candidate).map((i) => ({
            itemId: i.id,
            decision: 'accept',
            reason: 'source matched',
            missingEvidenceIds: [],
          })),
        };
      return {
        output: JSON.parse(JSON.stringify(behavior.edit(operation, output))) as T,
        reportedModelId: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        completedAt: '2026-09-07T00:00:00.000Z',
      };
    },
  };
  const dependencies = {
    ...f.dependencies,
    router,
    jobs: f.repositories.jobs,
    checkpoints: f.repositories.pipelineArtifacts,
  };
  const input = { ...f.input, sourceBundleId: bundle.id, existingTopics: [] };
  return {
    ...f,
    calls,
    behavior,
    dependencies,
    input,
    processor: () => new EvidencePipelineProcessor(dependencies),
  };
};

describe('EvidencePipelineProcessor', () => {
  it('completes all study stages through a ready Codex default null-model route', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      const features = ['topic_clustering', 'lecture_organize', 'lecture_verify'] as const;
      for (const feature of features) {
        const route = required(f.repositories.providerRoutes.get(feature));
        f.repositories.providerRoutes.update(
          { ...route, providerId: 'codex_cli', modelId: null, revision: route.revision + 1 },
          route.revision,
        );
      }
      f.repositories.providerDiagnostics.upsert(readyCodexDiagnostic(), null);
      const adapter: AiProviderAdapter<'codex_cli'> = {
        id: 'codex_cli',
        execute: (request) => {
          expect(request.modelId).toBeNull();
          return f.dependencies.router.execute(request);
        },
        inspect: async () => {
          throw new Error('No live inspection');
        },
        probe: async () => {
          throw new Error('No live probe');
        },
        listModels: async () => {
          throw new Error('No model listing');
        },
        cancel: () => undefined,
      };
      const router = new AiProviderRouter({
        routes: f.repositories.providerRoutes,
        diagnostics: f.repositories.providerDiagnostics,
        invocations: f.repositories.providerInvocations,
        adapters: new Map([['codex_cli', adapter]]),
        clock: () => new Date().toISOString(),
        id: randomUUID,
      });
      const processor = new EvidencePipelineProcessor({
        ...f.dependencies,
        router: {
          execute: (operation) =>
            features.some((feature) => feature === operation.feature)
              ? router.execute(operation)
              : f.dependencies.router.execute(operation),
        },
      });
      try {
        expect((await processor.processBundle(f.input)).topics).toHaveLength(3);
        const logs = f.repositories.providerInvocations.listForJob(f.input.jobId);
        expect(logs.map((log) => log.feature).sort()).toEqual([...features].sort());
        expect(
          logs.every((log) => log.selectedModelId === null && log.status === 'completed'),
        ).toBe(true);
      } finally {
        await router.shutdown();
        f.database.close();
      }
    }));
  it('runs the compatibility runtime through all six real-router stages and invalidates persisted profile and source-context edits', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      for (const saved of f.repositories.providerRoutes.list())
        f.repositories.providerRoutes.update(
          {
            ...saved,
            providerId: 'openai_api',
            modelId: 'gpt-5.5',
            enabled: true,
            revision: saved.revision + 1,
          },
          saved.revision,
        );
      f.repositories.providerDiagnostics.upsert(
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
          revision: 0,
        },
        null,
      );
      const adapter: AiProviderAdapter<'openai_api'> = {
        id: 'openai_api',
        execute: (request) => f.dependencies.router.execute(request),
        inspect: async () => {
          throw new Error('Unexpected inspection');
        },
        probe: async () => {
          throw new Error('Unexpected probe');
        },
        listModels: async () => {
          throw new Error('Unexpected model list');
        },
        cancel: () => undefined,
      };
      const router = new AiProviderRouter({
        routes: f.repositories.providerRoutes,
        diagnostics: f.repositories.providerDiagnostics,
        invocations: f.repositories.providerInvocations,
        adapters: new Map([['openai_api', adapter]]),
        clock: () => new Date().toISOString(),
        id: randomUUID,
      });
      const runtime = await createContentPipelineRuntime({
        repositories: f.repositories,
        userDataRoot: root,
        artifactRoot: join(root, 'artifacts'),
        providerRuntime: { router },
        metadata: f.metadata,
      });
      try {
        const job = required(f.repositories.jobs.get(f.input.jobId));
        const markdown = await runtime.compatibilityProcessor.process({
          jobId: job.id,
          courseId: job.courseId,
          sourceFileName: job.sourceFileName,
          sourceMediaType: job.sourceMediaType,
          sourceSha256: job.sourceSha256,
          summaryMode: job.summaryMode,
        });
        expect(markdown.markdownBody).toContain('Lecture study topics');
        expect(f.repositories.providerInvocations.listForJob(job.id)).toHaveLength(6);
        await runtime.processor.processBundle(f.input);
        expect(f.repositories.providerInvocations.listForJob(job.id)).toHaveLength(6);
        runtime.promptProfiles.save(
          { scope: 'global', courseId: null, feature: null },
          { name: 'global', additionalInstructions: '새로운 학습 지시', templateOverride: null },
          null,
        );
        await runtime.processor.processBundle(f.input);
        expect(f.repositories.providerInvocations.listForJob(job.id)).toHaveLength(12);
        const beforeNote = required(f.repositories.pipelineArtifacts.get(job.id, 'classification'));
        await runtime.processor.processBundle({
          ...f.input,
          contextBlocks: [{ role: 'user', kind: 'professor_note', text: '교수 메모 편집' }],
        });
        expect(f.repositories.providerInvocations.listForJob(job.id)).toHaveLength(18);
        expect(
          f.repositories.pipelineArtifacts.get(job.id, 'classification')?.identitySha256,
        ).not.toBe(beforeNote.identitySha256);
        await runtime.processor.processBundle({
          ...f.input,
          contextBlocks: [{ role: 'user', kind: 'source', text: '선택된 범위: 3장' }],
        });
        const logs = f.repositories.providerInvocations.listForJob(job.id);
        expect(logs).toHaveLength(24);
        for (const log of logs)
          expect(log).toMatchObject({
            status: 'completed',
            providerId: 'openai_api',
            selectedModelId: 'gpt-5.5',
            promptVersion: expect.stringMatching(/^[a-f0-9]{64}$/u),
            requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          });
      } finally {
        await runtime.shutdown();
        f.database.close();
      }
    }));
  it('splits into three topics, publishes sequential bundle checkpoints, and reuses cache with zero calls', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      try {
        const result = await f.processor().processBundle(f.input);
        expect(result.topics.map((t) => t.cluster.title)).toEqual([
          '시간복잡도',
          '배열',
          '연결리스트',
        ]);
        expect(f.calls.map((c) => c.outputSchemaId)).toEqual([
          'topic_clusters_v2',
          'study_content_v2',
          'study_verification_v1',
        ]);
        expect(await f.processor().processBundle(f.input)).toEqual(result);
        expect(f.calls).toHaveLength(3);
        for (const op of f.calls)
          expect(op.blocks.filter((b) => b.kind === 'source').every((b) => b.role === 'user')).toBe(
            true,
          );
      } finally {
        f.database.close();
      }
    }));
  it('resumes from the last completed stage after verifier failure', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      try {
        f.behavior.fail = 'lecture_verify';
        await expect(f.processor().processBundle(f.input)).rejects.toThrow('test provider failure');
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'synthesis')).not.toBeNull();
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'verification')).toBeNull();
        f.behavior.fail = '';
        await f.processor().processBundle(f.input);
        expect(f.calls.map((c) => c.feature)).toEqual([
          'topic_clustering',
          'lecture_organize',
          'lecture_verify',
          'lecture_verify',
        ]);
      } finally {
        f.database.close();
      }
    }));
  it('rejects job/course/bundle mismatches before provider calls', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      try {
        await expect(
          f.processor().processBundle({ ...f.input, courseId: randomUUID() }),
        ).rejects.toThrow();
        await expect(
          f.processor().processBundle({ ...f.input, sourceBundleId: randomUUID() }),
        ).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
      } finally {
        f.database.close();
      }
    }));
  it.each(['prompt', 'route', 'context', 'upstream'] as const)(
    'invalidates dependent caches after %s changes',
    async (change) =>
      withTempDirectory(async (root) => {
        const f = await pipelineFixture(root);
        try {
          await f.processor().processBundle(f.input);
          let input = { ...f.input, prompts: {} };
          if (change === 'prompt')
            input = {
              ...input,
              prompts: { topic_clustering: { oneOffInstructions: '더 세밀한 주제' } },
            };
          if (change === 'route') {
            const route = required(f.repositories.providerRoutes.get('topic_clustering'));
            f.repositories.providerRoutes.update(
              { ...route, revision: route.revision + 1, modelId: 'changed-model' },
              route.revision,
            );
          }
          if (change === 'context')
            input = {
              ...input,
              existingTopics: [
                {
                  id: randomUUID(),
                  courseId: f.input.courseId,
                  title: '기존',
                  aliases: [],
                  summary: '',
                  sessionDates: [],
                  acceptedContentSha256: 'a'.repeat(64),
                  provenance: [],
                },
              ],
            } as typeof input;
          if (change === 'upstream') {
            const prior = await f.services().evidence.extractEvidence(f.input);
            await f.artifacts.write({
              jobId: f.input.jobId,
              stage: 'evidence',
              schemaVersion: 1,
              identity: prior.identity,
              operationReceipts: prior.operationReceipts,
              value: { segments: prior.value.segments.map((e) => ({ ...e, confidence: 0.8 })) },
            });
          }
          await f.processor().processBundle(input);
          expect(f.calls).toHaveLength(6);
        } finally {
          f.database.close();
        }
      }),
  );
  it.each([
    'cache-route',
    'cache-context',
    'cache-pointer',
    'publish-route',
    'publish-upstream',
    'cancel',
  ] as const)('rejects %s mutations without publishing a stale checkpoint', async (change) =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      try {
        if (change.startsWith('cache')) await f.processor().processBundle(f.input);
        const previous = f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering');
        const controller = new AbortController();
        const existingTopics: unknown[] = [];
        let changed = false;
        const mutate = () => {
          if (changed) return;
          changed = true;
          if (change === 'cancel') controller.abort();
          else if (change === 'cache-context')
            existingTopics.push({
              id: randomUUID(),
              courseId: f.input.courseId,
              title: 'changed',
              aliases: [],
              summary: '',
              sessionDates: [],
              acceptedContentSha256: 'a'.repeat(64),
              provenance: [],
            });
          else if (change.includes('upstream') || change.includes('pointer'))
            f.database
              .prepare("DELETE FROM pipeline_artifacts WHERE job_id = ? AND stage = 'evidence'")
              .run(f.input.jobId);
          else {
            const route = required(f.repositories.providerRoutes.get('topic_clustering'));
            f.repositories.providerRoutes.update(
              { ...route, modelId: 'changed', revision: route.revision + 1 },
              route.revision,
            );
          }
        };
        const artifacts: typeof f.artifacts = {
          read: async (...args) => {
            const value = await f.artifacts.read(...args);
            if (args[1] === 'clustering' && change.startsWith('cache')) mutate();
            return value;
          },
          write: (value, options) =>
            f.artifacts.write(value, {
              ...options,
              beforeCommit: async () => {
                if (value.stage === 'clustering' && !change.startsWith('cache')) mutate();
                await options?.beforeCommit?.();
              },
            }),
        };
        await expect(
          new EvidencePipelineProcessor({ ...f.dependencies, artifacts }).processBundle({
            ...f.input,
            existingTopics: existingTopics as typeof f.input.existingTopics,
            signal: controller.signal,
          }),
        ).rejects.toThrow();
        expect(
          f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering')?.sha256 ?? null,
        ).toBe(previous?.sha256 ?? null);
      } finally {
        f.database.close();
      }
    }),
  );
  describe.each(['cache-read', 'publication', 'provider-call'] as const)(
    'source snapshot %s races',
    (window) => {
      it.each([
        'originalFileName',
        'mediaType',
        'stagedPath',
        'sizeBytes',
        'bundleTotalBytes',
        'bundleCount',
        'consistentByteChange',
        'sha256',
        'ordinal',
        'liveAlias',
      ] as const)('rejects %s changes and preserves the previous checkpoint', async (field) =>
        withTempDirectory(async (root) => {
          const f = await pipelineFixture(root);
          try {
            await f.processor().processBundle(f.input);
            const previous = required(
              f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering'),
            );
            const record = required(f.records[0]);
            const liveRecords = f.records.map((r) => ({ ...r }));
            let changed = false;
            const mutate = () => {
              if (changed) return;
              changed = true;
              switch (field) {
                case 'originalFileName':
                  f.database
                    .prepare('UPDATE source_records SET original_file_name = ? WHERE id = ?')
                    .run('renamed.pdf', record.id);
                  break;
                // Keep the filename/media pair schema-valid, so parsing alone cannot catch this race.
                case 'mediaType':
                  f.database
                    .prepare(
                      'UPDATE source_records SET media_type = ?, original_file_name = ? WHERE id = ?',
                    )
                    .run('image', 'renamed.png', record.id);
                  break;
                case 'stagedPath':
                  f.database
                    .prepare('UPDATE source_records SET staged_path = ? WHERE id = ?')
                    .run(join(root, 'replaced.pdf'), record.id);
                  break;
                case 'sizeBytes':
                  f.database
                    .prepare('UPDATE source_records SET size_bytes = size_bytes + 1 WHERE id = ?')
                    .run(record.id);
                  break;
                case 'bundleTotalBytes':
                  f.database
                    .prepare('UPDATE source_bundles SET total_bytes = total_bytes + 1 WHERE id = ?')
                    .run(f.input.sourceBundleId);
                  break;
                case 'bundleCount':
                  f.database
                    .prepare('UPDATE source_bundles SET source_count = 2 WHERE id = ?')
                    .run(f.input.sourceBundleId);
                  f.database
                    .prepare('UPDATE jobs SET source_count = 2 WHERE id = ?')
                    .run(f.input.jobId);
                  break;
                case 'consistentByteChange':
                  f.database
                    .prepare('UPDATE source_records SET size_bytes = size_bytes + 1 WHERE id = ?')
                    .run(record.id);
                  f.database
                    .prepare('UPDATE source_bundles SET total_bytes = total_bytes + 1 WHERE id = ?')
                    .run(f.input.sourceBundleId);
                  break;
                case 'sha256':
                  f.database
                    .prepare('UPDATE source_records SET sha256 = ? WHERE id = ?')
                    .run('d'.repeat(64), record.id);
                  break;
                case 'ordinal':
                  f.database
                    .prepare('UPDATE source_records SET ordinal = 1 WHERE id = ?')
                    .run(record.id);
                  break;
                case 'liveAlias':
                  required(liveRecords[0]).originalFileName = 'mutated-alias.pdf';
                  break;
              }
            };
            const artifacts: typeof f.artifacts = {
              read: async (...args) => {
                const value = await f.artifacts.read(...args);
                if (args[1] === 'clustering' && window === 'cache-read') mutate();
                return value;
              },
              write: (value, options) =>
                f.artifacts.write(value, {
                  ...options,
                  beforeCommit: async () => {
                    if (value.stage === 'clustering' && window === 'publication') mutate();
                    await options?.beforeCommit?.();
                  },
                }),
            };
            if (window === 'provider-call')
              f.behavior.edit = (_operation, output) => {
                mutate();
                return output;
              };
            const bundles = {
              ...f.dependencies.bundles,
              getByJobId: f.dependencies.bundles.getByJobId.bind(f.dependencies.bundles),
              listRecords: (id: string) =>
                field === 'liveAlias' ? liveRecords : f.dependencies.bundles.listRecords(id),
              insert: f.dependencies.bundles.insert.bind(f.dependencies.bundles),
            };
            await expect(
              new EvidencePipelineProcessor({
                ...f.dependencies,
                artifacts,
                bundles,
              }).processBundle({
                ...f.input,
                ...(window === 'cache-read'
                  ? {}
                  : {
                      prompts: {
                        topic_clustering: {
                          oneOffInstructions: 'Force a new clustering operation',
                        },
                      },
                    }),
              }),
            ).rejects.toThrow();
            expect(changed).toBe(true);
            expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering')).toEqual(
              previous,
            );
            expect(f.calls).toHaveLength(window === 'cache-read' ? 3 : 4);
          } finally {
            f.database.close();
          }
        }),
      );
    },
  );
  it.each(['cache-read', 'publication'] as const)(
    'keeps cancellation precedence over a simultaneous source mismatch during %s',
    async (window) =>
      withTempDirectory(async (root) => {
        const f = await pipelineFixture(root);
        try {
          await f.processor().processBundle(f.input);
          const previous = required(
            f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering'),
          );
          const controller = new AbortController();
          const mutate = () => {
            controller.abort();
            f.database
              .prepare('UPDATE source_bundles SET total_bytes = total_bytes + 1 WHERE id = ?')
              .run(f.input.sourceBundleId);
          };
          const artifacts: typeof f.artifacts = {
            read: async (...args) => {
              const value = await f.artifacts.read(...args);
              if (args[1] === 'clustering' && window === 'cache-read') mutate();
              return value;
            },
            write: (value, options) =>
              f.artifacts.write(value, {
                ...options,
                beforeCommit: async () => {
                  if (value.stage === 'clustering' && window === 'publication') mutate();
                  await options?.beforeCommit?.();
                },
              }),
          };
          await expect(
            new EvidencePipelineProcessor({ ...f.dependencies, artifacts }).processBundle({
              ...f.input,
              signal: controller.signal,
              ...(window === 'cache-read'
                ? {}
                : {
                    prompts: { topic_clustering: { oneOffInstructions: 'Force a new operation' } },
                  }),
            }),
          ).rejects.toThrow(
            window === 'cache-read' ? 'PROVIDER_CANCELLED' : 'PIPELINE_ARTIFACT_CANCELLED',
          );
          expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering')).toEqual(
            previous,
          );
        } finally {
          f.database.close();
        }
      }),
  );
  it('records a bundle receipt and metadata identities, while reading legacy v1 artifacts without reusing them', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root, 2);
      try {
        const evidence = await f.services().evidence.extractEvidence(f.input);
        const route = required(f.repositories.providerRoutes.get('topic_clustering'));
        const legacy = {
          sources: evidence.identity.sources.map((s) => ({
            sourceId: s.sourceId,
            sha256: s.sha256,
          })),
          upstream: [],
          prompt: { id: 'old', version: '1', sha256: 'b'.repeat(64) },
          route: {
            feature: route.feature,
            providerId: route.providerId,
            modelId: route.modelId,
            revision: route.revision,
          },
        };
        const old = PipelineArtifactWriteSchema.parse({
          jobId: f.input.jobId,
          stage: 'clustering',
          schemaVersion: 1,
          identity: legacy,
          value: { topics: [] },
        });
        await f.artifacts.write(old);
        expect(await f.artifacts.read(f.input.jobId, 'clustering', old.identity)).not.toBeNull();
        await f.processor().processBundle(f.input);
        expect(f.calls).toHaveLength(3);
        const clusterPointer = required(
          f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering'),
        );
        const stored = PipelineArtifactWriteSchema.parse(
          JSON.parse(await readFile(join(root, 'artifacts', clusterPointer.relativePath), 'utf8')),
        );
        expect(stored.identity).toMatchObject({
          identityVersion: 5,
          operationVersion: 'study-stages-v2',
          sources: evidence.identity.sources,
          operation: { sourceIds: f.records.map((r) => r.id) },
        });
        const { contextSha256: _contextHash, ...priorIdentity } = StudyStageIdentitySchema.parse(
          stored.identity,
        );
        const legacyV3 = PipelineArtifactWriteSchema.parse({
          ...stored,
          identity: { ...priorIdentity, identityVersion: 3, operationVersion: 'study-stages-v1' },
        });
        await f.artifacts.write(legacyV3);
        expect(
          await f.artifacts.read(f.input.jobId, 'clustering', legacyV3.identity, 1),
        ).not.toBeNull();
        expect(await f.artifacts.read(f.input.jobId, 'clustering', stored.identity, 1)).toBeNull();
        expect('bundleReceipt' in stored ? stored.bundleReceipt : null).toEqual({
          sourceIds: f.records.map((r) => r.id),
          requestId: f.calls[0]?.requestId,
        });
        expect(
          PipelineArtifactWriteSchema.safeParse({
            ...stored,
            bundleReceipt: { sourceIds: [randomUUID()], requestId: randomUUID() },
          }).success,
        ).toBe(false);
        const op = required(f.calls[0]);
        const prompt = f.dependencies.composer.compose({
          feature: 'topic_clustering',
          courseId: f.input.courseId,
        });
        expect(op.outputJsonSchema.additionalProperties).toBe(false);
        const identity = StudyStageIdentitySchema.parse({
          identityVersion: 5,
          operationVersion: 'study-stages-v2',
          contextSha256: sha256CanonicalJson([]),
          sources: evidence.identity.sources,
          upstream: [],
          existingTopicContextSha256: sha256CanonicalJson([]),
          operation: {
            sourceIds: f.records.map((r) => r.id),
            route,
            prompt: prompt.promptIdentity,
          },
        });
        expect(clusterPointer.identitySha256).not.toBe(sha256CanonicalJson(old.identity));
        expect(identity.sources).toEqual(evidence.identity.sources);
        expect(PipelineArtifactWriteSchema.safeParse({ ...old, identity }).success).toBe(false);
        expect(
          PipelineArtifactWriteSchema.safeParse({
            jobId: f.input.jobId,
            stage: 'synthesis',
            schemaVersion: 1,
            identity: old.identity,
            value: { claims: [], conflicts: [], sessionDates: [] },
          }).success,
        ).toBe(true);
      } finally {
        f.database.close();
      }
    }));
  it('fails an oversized aggregate explicitly before the clustering provider call', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root);
      try {
        const previous = f.response.value;
        f.response.value = (op, source) =>
          op.feature === 'media_extraction'
            ? {
                segments: Array.from({ length: 40 }, () => ({
                  id: randomUUID(),
                  sourceId: source.id,
                  text: '한'.repeat(20_000),
                  kind: 'explanation',
                  confidence: 1,
                  locator: { kind: 'document', page: 1 },
                })),
              }
            : previous(op, source);
        await expect(f.processor().processBundle(f.input)).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'clustering')).toBeNull();
      } finally {
        f.database.close();
      }
    }));
  it('merges separate uploads into one existing topic as an explicit delta preserving prior dates', async () =>
    withTempDirectory(async (root) => {
      const f = await pipelineFixture(root, 2);
      try {
        const previous = f.response.value;
        f.response.value = (op, source) => {
          const output = previous(op, source) as { segments?: object[] };
          return output.segments
            ? { segments: output.segments.map((e) => ({ ...e, sessionDate: '2026-09-09' })) }
            : output;
        };
        const existing = {
          id: randomUUID(),
          courseId: f.input.courseId,
          title: '배열',
          aliases: ['array'],
          summary: '이미 수락된 과거 내용',
          sessionDates: ['2026-09-07'],
          acceptedContentSha256: 'a'.repeat(64),
          provenance: [{ sourceId: randomUUID(), evidenceIds: [randomUUID()] }],
        };
        f.behavior.edit = (op, output) => {
          if (op.feature === 'lecture_verify') return output;
          const data = output as {
            contentSchemaVersion: number;
            topics: Array<{ evidenceIds: string[]; cluster: { evidenceIds: string[] } }>;
          };
          const first = required(data.topics[0]);
          if (op.feature === 'topic_clustering')
            return {
              contentSchemaVersion: 2,
              topics: [
                {
                  ...first,
                  title: '배열',
                  action: 'merge',
                  existingTopicId: existing.id,
                  sessionDates: ['2026-09-07', '2026-09-09'],
                },
              ],
            };
          return {
            ...data,
            topics: data.topics.map((t) => ({
              ...t,
              contentMode: 'merge_delta',
              sessions: [
                { date: '2026-09-07', evidenceIds: [] },
                { date: '2026-09-09', evidenceIds: t.cluster.evidenceIds },
              ],
            })),
          };
        };
        const result = await f
          .processor()
          .processBundle({ ...f.input, existingTopics: [existing] });
        expect(result.topics).toHaveLength(1);
        expect(result.topics[0]).toMatchObject({
          contentMode: 'merge_delta',
          cluster: { existingTopicId: existing.id, sessionDates: ['2026-09-07', '2026-09-09'] },
        });
        expect(new Set(result.topics[0]?.citations.map((c) => c.sourceId)).size).toBe(2);
        expect(existing.summary).toBe('이미 수락된 과거 내용');
      } finally {
        f.database.close();
      }
    }));
  it.each(['corrupt', 'missing'] as const)(
    'refuses downstream reuse when the upstream artifact is %s',
    async (failure) =>
      withTempDirectory(async (root) => {
        const f = await pipelineFixture(root);
        try {
          await f.processor().processBundle(f.input);
          const pointer = required(f.repositories.pipelineArtifacts.get(f.input.jobId, 'evidence'));
          const path = join(root, 'artifacts', pointer.relativePath);
          if (failure === 'corrupt') await writeFile(path, '{}');
          else await unlink(path);
          await expect(f.processor().processBundle(f.input)).rejects.toThrow();
          expect(f.calls).toHaveLength(3);
        } finally {
          f.database.close();
        }
      }),
  );
});
