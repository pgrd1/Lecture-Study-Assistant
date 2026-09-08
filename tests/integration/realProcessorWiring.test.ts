import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ContentClassificationService } from '../../src/application/content/contentClassificationService';
import { EvidencePipelineProcessor } from '../../src/application/content/evidencePipelineProcessor';
import { AiProviderRouter } from '../../src/application/providers/aiProviderRouter';
import { createProviderOperation } from '../../src/core/ports/aiProvider';
import { FakeAiProviderAdapter } from '../../src/infrastructure/providers/fake/fakeAiProviderAdapter';
import { FoundationApplication } from '../../src/main/foundationApplication';
import { createLifecyclePreferenceStore } from '../../src/main/lifecyclePreferences';
import { createProviderRuntime } from '../../src/main/providerRuntime';
import { resolveRuntimePaths } from '../../src/main/runtimePaths';
import {
  PipelineArtifactIdentitySchema,
  PipelineArtifactWriteSchema,
} from '../../src/shared/contracts/pipelineArtifact';
import { APP_ERROR_MESSAGES } from '../../src/shared/errors';
import { withTempDirectory } from '../testkit/tempDirectory';
import { classification, contentFixture, required } from '../unit/application/contentFixtures';

const heldRuntime = async (root: string) => {
  const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
  const f = await contentFixture(root);
  const bundle = required(f.repositories.sourceBundles.getByJobId(f.input.jobId));
  f.database
    .prepare('UPDATE jobs SET source_bundle_id = ? WHERE id = ?')
    .run(bundle.id, f.input.jobId);
  const adapter = new FakeAiProviderAdapter('openai_api');
  const route = required(f.repositories.providerRoutes.get('content_classification'));
  f.repositories.providerDiagnostics.upsert(
    {
      providerId: 'openai_api',
      status: 'ready',
      version: null,
      selectedModelId: route.modelId,
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
  const input = { ...f.input, sourceBundleId: bundle.id, existingTopics: [] };
  const operation = createProviderOperation({
    requestId: randomUUID(),
    feature: 'content_classification',
    jobId: input.jobId,
    outputSchemaId: 'lecture_output',
    outputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { const: true } },
      required: ['ok'],
    },
    parseOutput: () => ({ ok: true }),
    blocks: [],
    timeoutMs: 30_000,
    maxOutputTokens: 100,
    signal: input.signal,
  });
  return { ...f, runtime, adapter, input, operation };
};

describe('production processor wiring', () => {
  it.each(['processor', 'router', 'compatibilityProcessor'] as const)(
    'settles exposed %s cancellation before permitting SQLite close',
    async (entry) => {
      await withTempDirectory(async (root) => {
        const f = await heldRuntime(root);
        const job = required(f.repositories.jobs.get(f.input.jobId));
        f.adapter.holdNextCall();
        const work =
          entry === 'processor'
            ? f.runtime.processor.processBundle(f.input)
            : entry === 'router'
              ? f.runtime.router.execute(f.operation)
              : f.runtime.compatibilityProcessor.process({
                  jobId: job.id,
                  courseId: job.courseId,
                  sourceFileName: job.sourceFileName,
                  sourceMediaType: job.sourceMediaType,
                  sourceSha256: job.sourceSha256,
                  summaryMode: job.summaryMode,
                });
        let settled = false;
        const pending = work.then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        try {
          await vi.waitFor(() => expect(f.adapter.activeCalls).toBe(1));
          await f.runtime.router.shutdown();
          expect(settled).toBe(true);
          expect(await pending).toMatchObject({ code: 'PROVIDER_CANCELLED' });
          expect(f.adapter.activeCalls).toBe(0);
          expect(f.repositories.providerInvocations.listForJob(f.input.jobId)[0]?.status).toBe(
            'cancelled',
          );
          f.database.close();
          await expect(f.runtime.processor.processBundle(f.input)).rejects.toMatchObject({
            code: 'PROVIDER_CANCELLED',
          });
          await expect(f.runtime.router.execute(f.operation)).rejects.toMatchObject({
            code: 'PROVIDER_CANCELLED',
          });
        } finally {
          await f.runtime.shutdown();
          f.database.close();
        }
      });
    },
  );
  it.each(['processor', 'router'] as const)(
    'retains SQLite when exposed direct %s execution ignores cancellation until after the shutdown deadline',
    async (entry) => {
      await withTempDirectory(async (root) => {
        const f = await heldRuntime(root);
        const closed = vi.spyOn(f.database, 'close');
        f.adapter.holdNextCallIgnoringCancellation();
        const pending = (
          entry === 'processor'
            ? f.runtime.processor.processBundle(f.input)
            : f.runtime.router.execute(f.operation)
        ).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.waitFor(() => expect(f.adapter.activeCalls).toBe(1));
        vi.useFakeTimers();
        try {
          const stopped = f.runtime.shutdown().then(
            () => {
              f.database.close();
              return null;
            },
            (error: unknown) => error,
          );
          await vi.advanceTimersByTimeAsync(15_000);
          const result = await stopped;
          expect(closed).not.toHaveBeenCalled();
          expect(result).toMatchObject({ code: 'PROVIDER_CANCELLED' });
          expect(f.repositories.providerInvocations.listForJob(f.input.jobId)[0]?.status).toBe(
            'running',
          );
          f.adapter.release({
            output: { ok: true },
            reportedModelId: null,
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
            completedAt: new Date().toISOString(),
          });
          expect(await pending).toMatchObject({ code: 'PROVIDER_CANCELLED' });
          await f.runtime.shutdown();
          expect(f.repositories.providerInvocations.listForJob(f.input.jobId)[0]?.status).toBe(
            'cancelled',
          );
          f.database.close();
          expect(closed).toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
          f.database.close();
        }
      });
    },
  );

  it('tracks direct cache-path processor work even when the router has no active invocation', async () => {
    await withTempDirectory(async (root) => {
      const f = await heldRuntime(root);
      await f.services().classification.classifySources(f.input);
      let release: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = f.metadata.measure.getMockImplementation();
      if (!original) throw new Error('Missing metadata fixture');
      f.metadata.measure.mockImplementation(async (...args) => {
        await waiting;
        return original(...args);
      });
      const pending = f.runtime.processor.processBundle(f.input).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(f.metadata.measure).toHaveBeenCalledTimes(2));
      vi.useFakeTimers();
      try {
        const stopped = f.runtime.shutdown().then(
          () => null,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await stopped).toMatchObject({ code: 'PROVIDER_CANCELLED' });
        expect(f.adapter.calls).toHaveLength(0);
        release();
        expect(await pending).toMatchObject({ code: 'PROVIDER_CANCELLED' });
        await f.runtime.shutdown();
      } finally {
        release();
        vi.useRealTimers();
        f.database.close();
      }
    });
  });
  it.each(['chooseVault', 'chooseQueue'] as const)(
    'validates %s before any storage writes or settings edits',
    async (method) => {
      const { createContentPipelineRuntime } = await import(
        '../../src/main/contentPipelineRuntime'
      );
      await withTempDirectory(async (root) => {
        const userDataRoot = join(root, 'appData');
        await mkdir(userDataRoot);
        const f = await contentFixture(userDataRoot);
        createLifecyclePreferenceStore(f.repositories.settings).load();
        const runtime = await createContentPipelineRuntime({
          repositories: f.repositories,
          userDataRoot,
          artifactRoot: join(userDataRoot, 'artifacts'),
          providerRuntime: { router: { execute: vi.fn(), shutdown: async () => undefined } },
        });
        const application = new FoundationApplication({
          repositories: f.repositories,
          stagingRoot: join(userDataRoot, 'staging'),
          processor: runtime.compatibilityProcessor,
          validateStorageRoots: runtime.validateStorageRoots,
          diagnostics: { export: async () => '' },
          setAutoStart: () => undefined,
          onStateChanged: () => undefined,
        });
        try {
          const settings = f.repositories.settings.get();
          const files = await readdir(root, { recursive: true });
          for (const candidate of [
            join(userDataRoot, 'artifacts'),
            userDataRoot,
            join(userDataRoot, 'nested'),
            join(userDataRoot, 'artifacts', 'nested'),
            root,
          ]) {
            await expect(application[method](candidate)).rejects.toMatchObject({
              code: 'PROVIDER_UNSAFE_VERSION',
            });
            expect(f.repositories.settings.get()).toEqual(settings);
            expect(await readdir(root, { recursive: true })).toEqual(files);
          }
          const valid = join(root, method === 'chooseVault' ? 'valid-vault' : 'valid-queue');
          if (method === 'chooseQueue') await mkdir(valid);
          await application[method](valid);
          expect(
            f.repositories.settings.get()?.[
              method === 'chooseVault' ? 'vaultPath' : 'icloudQueuePath'
            ],
          ).toBe(valid);
          const counterpart = method === 'chooseVault' ? 'icloudQueuePath' : 'vaultPath';
          const selected = required(f.repositories.settings.get());
          f.repositories.settings.update(
            { ...selected, [counterpart]: userDataRoot, revision: selected.revision + 1 },
            selected.revision,
          );
          const invalidPair = f.repositories.settings.get();
          const unchangedFiles = await readdir(root, { recursive: true });
          await expect(
            application[method](join(root, 'new-valid-candidate')),
          ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
          expect(f.repositories.settings.get()).toEqual(invalidPair);
          expect(await readdir(root, { recursive: true })).toEqual(unchangedFiles);
        } finally {
          await runtime.shutdown();
          await application.shutdown();
          f.database.close();
        }
      });
    },
  );
  it.each(['contextBlocks', 'prompts', 'courseId'] as const)(
    'rejects an alternating top-level %s getter without executing it',
    async (field) => {
      const { snapshotContentAttempt } = await import(
        '../../src/application/content/contentAttemptSnapshot'
      );
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const getter = vi
            .fn()
            .mockReturnValueOnce(
              field === 'contextBlocks' ? [] : field === 'prompts' ? {} : f.input.courseId,
            )
            .mockImplementation(() => [
              { role: 'user', kind: 'source', text: 'x'.repeat(100_000) },
            ]);
          const input = Object.defineProperty({ ...f.input }, field, {
            enumerable: true,
            get: getter,
          });
          expect(() => snapshotContentAttempt(f.dependencies, input)).toThrow();
          expect(getter).not.toHaveBeenCalled();
        } finally {
          f.database.close();
        }
      });
    },
  );

  it('rejects context accessors, aliases and oversized arrays before snapshotting', async () => {
    const { snapshotContentAttempt } = await import(
      '../../src/application/content/contentAttemptSnapshot'
    );
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const getter = vi.fn(() => 'source');
        const accessor = Object.defineProperty({ role: 'user', kind: 'source' }, 'text', {
          enumerable: true,
          get: getter,
        });
        const block = { role: 'user' as const, kind: 'source' as const, text: 'source' };
        for (const blocks of [
          [accessor],
          [block, block],
          Array.from({ length: 17 }, () => ({ ...block })),
          [{ ...block, text: 'x'.repeat(100_000) }],
        ]) {
          expect(() =>
            snapshotContentAttempt(f.dependencies, {
              ...f.input,
              contextBlocks: blocks as (typeof block)[],
            }),
          ).toThrow();
        }
        expect(getter).not.toHaveBeenCalled();
      } finally {
        f.database.close();
      }
    });
  });
  it.each(['vaultPath', 'icloudQueuePath'] as const)(
    'rejects artifact storage inside configured %s',
    async (field) => {
      const { createContentPipelineRuntime } = await import(
        '../../src/main/contentPipelineRuntime'
      );
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          createLifecyclePreferenceStore(f.repositories.settings).load();
          const current = required(f.repositories.settings.get());
          f.repositories.settings.update(
            { ...current, [field]: root, revision: current.revision + 1 },
            current.revision,
          );
          await expect(
            createContentPipelineRuntime({
              repositories: f.repositories,
              userDataRoot: root,
              artifactRoot: join(root, 'artifacts'),
              providerRuntime: { router: { execute: vi.fn(), shutdown: vi.fn() } },
            }),
          ).rejects.toMatchObject({ code: 'PROVIDER_UNSAFE_VERSION' });
        } finally {
          f.database.close();
        }
      });
    },
  );

  it('keeps legacy v2 checkpoint JSON readable but never reuses it for context-aware operations', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const result = await f.services().classification.classifySources(f.input);
        const { contextSha256: _context, ...old } = result.identity;
        const legacy = PipelineArtifactIdentitySchema.parse({
          ...old,
          identityVersion: 2,
          operationVersion: 'content-stages-v1',
        });
        const artifact = await f.artifacts.write(
          PipelineArtifactWriteSchema.parse({
            jobId: f.input.jobId,
            stage: 'classification',
            schemaVersion: 2,
            identity: legacy,
            operationReceipts: result.operationReceipts,
            value: result.value,
          }),
        );
        expect(await f.artifacts.read(f.input.jobId, 'classification', legacy, 2)).toMatchObject(
          artifact,
        );
        expect(
          await f.artifacts.read(f.input.jobId, 'classification', result.identity, 2),
        ).toBeNull();
        await f.services().classification.classifySources(f.input);
        expect(f.calls).toHaveLength(2);
      } finally {
        f.database.close();
      }
    });
  });
  it('bounds an unresponsive shutdown with a fixed public error', async () => {
    const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const runtime = await createContentPipelineRuntime({
        repositories: f.repositories,
        userDataRoot: root,
        artifactRoot: join(root, 'artifacts'),
        providerRuntime: {
          router: { execute: vi.fn(), shutdown: () => new Promise(() => undefined) },
        },
      });
      vi.useFakeTimers();
      try {
        const rejected = vi.fn();
        void runtime.shutdown().catch(rejected);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'PROVIDER_CANCELLED',
            displayMessage: APP_ERROR_MESSAGES.PROVIDER_CANCELLED,
          }),
        );
      } finally {
        vi.useRealTimers();
        f.database.close();
      }
    });
  });
  it('rejects a persisted downstream profile edit during classification before publishing a checkpoint', async () => {
    const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const bundle = required(f.repositories.sourceBundles.getByJobId(f.input.jobId));
      f.database
        .prepare('UPDATE jobs SET source_bundle_id = ? WHERE id = ?')
        .run(bundle.id, f.input.jobId);
      let edit = () => undefined;
      const runtime = await createContentPipelineRuntime({
        repositories: f.repositories,
        userDataRoot: root,
        artifactRoot: join(root, 'artifacts'),
        metadata: f.metadata,
        providerRuntime: {
          router: {
            execute: async (operation) => {
              const result = await f.dependencies.router.execute(operation);
              edit();
              return result;
            },
            shutdown: async () => undefined,
          },
        },
      });
      try {
        const key = {
          scope: 'feature',
          courseId: f.input.courseId,
          feature: 'lecture_organize',
        } as const;
        runtime.promptProfiles.save(
          key,
          { name: 'organize', additionalInstructions: 'first revision', templateOverride: null },
          null,
        );
        edit = () => {
          runtime.promptProfiles.save(
            key,
            {
              name: 'organize',
              additionalInstructions: 'edited after source work started',
              templateOverride: null,
            },
            0,
          );
        };
        await expect(
          runtime.processor.processBundle({
            ...f.input,
            sourceBundleId: bundle.id,
            existingTopics: [],
          }),
        ).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' });
        expect(f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification')).toBeNull();
        expect(f.calls).toHaveLength(1);
      } finally {
        await runtime.shutdown();
        f.database.close();
      }
    });
  });

  it('assembles real adapters with zero provider or credential calls, and fails unavailable routes publicly', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const secretStore = { get: vi.fn(), has: vi.fn(), set: vi.fn(), delete: vi.fn() };
      const network = vi.spyOn(globalThis, 'fetch');
      const runtime = createProviderRuntime({
        repositories: f.repositories,
        secretStore,
        paths: resolveRuntimePaths({ defaultUserDataPath: root, environment: {}, e2eBuild: false }),
      });
      try {
        expect(Object.hasOwn(runtime, 'adapters')).toBe(false);
        expect(runtime.providerIds).toEqual([
          'openai_api',
          'gemini_api',
          'claude_api',
          'codex_cli',
        ]);
        await expect(
          new ContentClassificationService({
            ...f.dependencies,
            router: runtime.router,
          }).classifySources(f.input),
        ).rejects.toMatchObject({
          code: 'PROVIDER_NOT_READY',
          displayMessage: APP_ERROR_MESSAGES.PROVIDER_NOT_READY,
        });
        expect(network).not.toHaveBeenCalled();
        for (const call of Object.values(secretStore)) expect(call).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
        await runtime.shutdown();
        f.database.close();
      }
    });
  });

  it('persists the effective prompt SHA and saved route identity through the real router and artifact store', async () => {
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const adapter = new FakeAiProviderAdapter('openai_api');
      const execute = vi.spyOn(adapter, 'execute');
      const route = required(f.repositories.providerRoutes.get('content_classification'));
      f.repositories.providerDiagnostics.upsert(
        {
          providerId: 'openai_api',
          status: 'ready',
          version: null,
          selectedModelId: route.modelId,
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
      const router = new AiProviderRouter({
        routes: f.repositories.providerRoutes,
        diagnostics: f.repositories.providerDiagnostics,
        invocations: f.repositories.providerInvocations,
        adapters: new Map([['openai_api', adapter]]),
        clock: () => new Date().toISOString(),
        id: randomUUID,
      });
      try {
        const service = new ContentClassificationService({ ...f.dependencies, router });
        for (const text of ['one', 'two']) {
          adapter.queueResult(classification(required(f.records[0]).id));
          await service.classifySources({
            ...f.input,
            prompts: { content_classification: { oneOffInstructions: text } },
          });
        }
        const logs = f.repositories.providerInvocations.listForJob(f.input.jobId);
        for (const [request] of execute.mock.calls) {
          expect(request).not.toHaveProperty('composedPromptSha256');
          expect(request.promptVersion).toMatch(/^[a-f0-9]{64}$/u);
        }
        expect(logs).toHaveLength(2);
        expect(new Set(logs.map((log) => log.promptVersion)).size).toBe(2);
        expect(new Set(logs.map((log) => log.requestSha256)).size).toBe(2);
        for (const log of logs)
          expect(log).toMatchObject({
            providerId: 'openai_api',
            selectedModelId: route.modelId,
            routeRevision: route.revision,
            promptVersion: expect.stringMatching(/^[a-f0-9]{64}$/u),
            responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            status: 'completed',
          });
        expect(f.repositories.providerRoutes.get(route.feature)).toEqual(route);
        const pointer = required(
          f.repositories.pipelineArtifacts.get(f.input.jobId, 'classification'),
        );
        const stored = JSON.parse(
          await readFile(join(root, 'artifacts', pointer.relativePath), 'utf8'),
        );
        expect(stored.identity.operations[0].route).toEqual(route);
        expect(logs.map((log) => log.promptVersion)).toContain(
          stored.identity.operations[0].prompt.sha256,
        );
      } finally {
        await router.shutdown();
        f.database.close();
      }
    });
  });

  it('rejects an artifact root that is a junction', async () => {
    const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const linked = join(root, 'linked-artifacts');
        await symlink(join(root, 'artifacts'), linked, 'junction');
        await expect(
          createContentPipelineRuntime({
            repositories: f.repositories,
            userDataRoot: root,
            artifactRoot: linked,
            providerRuntime: { router: { execute: vi.fn(), shutdown: vi.fn() } },
          }),
        ).rejects.toThrow();
      } finally {
        f.database.close();
      }
    });
  });
  it('snapshots every prompt at attempt start and rejects later edits', async () => {
    const { snapshotContentAttempt } = await import(
      '../../src/application/content/contentAttemptSnapshot'
    );
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        const prompts = { lecture_organize: { oneOffInstructions: 'first' } };
        const attempt = snapshotContentAttempt(f.dependencies, { ...f.input, prompts });
        prompts.lecture_organize.oneOffInstructions = 'second';
        expect(attempt.input.prompts?.lecture_organize?.oneOffInstructions).toBe('first');
        expect(() => attempt.dependencies.assertAttemptCurrent?.()).toThrow();
      } finally {
        f.database.close();
      }
    });
  });
  it('constructs the evidence processor without reading sources or calling providers', async () => {
    const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      const execute = vi.fn();
      const shutdown = vi.fn(async () => undefined);
      try {
        const runtime = await createContentPipelineRuntime({
          repositories: f.repositories,
          userDataRoot: root,
          artifactRoot: join(root, 'artifacts'),
          providerRuntime: { router: { execute, shutdown } },
          metadata: f.metadata,
        });
        expect(runtime.processor).toBeInstanceOf(EvidencePipelineProcessor);
        expect(execute).not.toHaveBeenCalled();
        expect(f.metadata.measure).not.toHaveBeenCalled();
        await runtime.shutdown();
        expect(shutdown).toHaveBeenCalledOnce();
      } finally {
        f.database.close();
      }
    });
  });

  it('rejects missing and external artifact roots', async () => {
    const { createContentPipelineRuntime } = await import('../../src/main/contentPipelineRuntime');
    await withTempDirectory(async (root) => {
      const f = await contentFixture(root);
      try {
        await mkdir(join(root, 'userData'));
        for (const artifactRoot of [join(root, 'artifacts'), join(root, 'userData', 'missing')]) {
          await expect(
            createContentPipelineRuntime({
              repositories: f.repositories,
              userDataRoot: join(root, 'userData'),
              artifactRoot,
              providerRuntime: { router: { execute: vi.fn(), shutdown: vi.fn() } },
            }),
          ).rejects.toThrow();
        }
      } finally {
        f.database.close();
      }
    });
  });

  it('has no production FakeProcessor import or construction', async () => {
    for (const path of [
      'src/main/foundationApplication.ts',
      'src/main/bootstrap.ts',
      'src/main/contentPipelineRuntime.ts',
      'src/main/providerRuntime.ts',
    ]) {
      expect(await readFile(path, 'utf8')).not.toMatch(/FakeProcessor|fakeProcessor/u);
    }
  });

  it.each(['professor_note', 'source'] as const)(
    'invalidates unchanged files when %s context changes',
    async (kind) => {
      await withTempDirectory(async (root) => {
        const f = await contentFixture(root);
        try {
          const first = await f.services().classification.classifySources({
            ...f.input,
            contextBlocks: [{ role: 'user', kind, text: 'scope one' }],
          });
          const second = await f.services().classification.classifySources({
            ...f.input,
            contextBlocks: [{ role: 'user', kind, text: 'scope two' }],
          });
          expect(f.calls).toHaveLength(2);
          expect(second.artifact.identitySha256).not.toBe(first.artifact.identitySha256);
          expect(second.identity.operations[0]?.prompt).toEqual(
            first.identity.operations[0]?.prompt,
          );
          expect(f.calls[1]?.blocks).toContainEqual({ role: 'user', kind, text: 'scope two' });
        } finally {
          f.database.close();
        }
      });
    },
  );
});
